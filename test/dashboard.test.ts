import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const APPROVER = "controller@example.com";

const POLICY: PolicyRules = {
  currency: "USD",
  escalation: { amountCents: 100_00 },
  budgets: { perAgent: { dailyCents: 500_00 } },
};

let orgId: string;
let apiKey: string;
let cookie: string;

beforeAll(async () => {
  const org = await provisionOrg({
    name: "Dashboard Org",
    agentId: "dash-agent",
    approverEmail: APPROVER,
    policy: POLICY,
  });
  orgId = org.orgId;
  apiKey = org.apiKey;

  // Mint a session cookie directly; the Kinde OIDC round-trip that would
  // normally produce it is covered separately below with a mocked endpoint.
  const session = await signToken("test-session-secret", {
    purpose: "session",
    email: APPROVER,
    orgId,
    exp: Date.now() + SESSION_TTL_MS,
  });
  cookie = `${SESSION_COOKIE}=${session}`;
});

const get = (path: string) =>
  SELF.fetch(`http://example.com${path}`, { headers: { cookie } });

const postForm = (path: string, fields: Record<string, string>) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

describe("Kinde OIDC login", () => {
  // Tests share the isolate with the Worker, so stubbing global fetch
  // intercepts the Worker's outbound call to Kinde's token endpoint.
  const realFetch = globalThis.fetch;
  let tokenResponse: () => Response;
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://test-kinde.example/oauth2/token") {
        return tokenResponse();
      }
      return realFetch(input as any, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

  it("completes the authorization-code round trip", async () => {
    // Step 1: /auth/login redirects to Kinde with a state cookie.
    const login = await SELF.fetch("http://example.com/auth/login", {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location")!);
    expect(location.origin).toBe("https://test-kinde.example");
    expect(location.pathname).toBe("/oauth2/auth");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    const state = location.searchParams.get("state")!;
    const stateCookie = login.headers.get("set-cookie")!.split(";")[0];

    // Step 2: Kinde's token endpoint is mocked to return an id_token.
    const idToken = [
      b64url({ alg: "RS256", typ: "JWT" }),
      b64url({
        iss: "https://test-kinde.example",
        aud: "test-client-id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        email: APPROVER,
      }),
      "sig",
    ].join(".");
    tokenResponse = () => Response.json({ id_token: idToken });

    // Step 3: the callback exchanges the code and starts a session.
    const callback = await SELF.fetch(
      `http://example.com/auth/callback?code=fake-code&state=${state}`,
      { headers: { cookie: stateCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
    const sessionCookie = callback.headers
      .get("set-cookie")!
      .split(",")
      .find((v) => v.trim().startsWith(SESSION_COOKIE))!
      .split(";")[0];

    const page = await SELF.fetch("http://example.com/dashboard", {
      headers: { cookie: sessionCookie },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pending approvals");
  });

  it("rejects a state mismatch", async () => {
    const res = await SELF.fetch(
      "http://example.com/auth/callback?code=x&state=forged",
      { headers: { cookie: "vs_oauth_state=other" }, redirect: "manual" }
    );
    expect(res.status).toBe(401);
  });
});

describe("dashboard", () => {
  it("redirects anonymous visitors to login", async () => {
    const res = await SELF.fetch("http://example.com/dashboard", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("shows pending approvals and lets the approver decide", async () => {
    const session = new McpSession(apiKey);
    await session.initialize();
    const pending = await session.call("request_purchase", {
      vendor: "Enterprise SaaS Ltd",
      amount_cents: 150_00,
      currency: "USD",
      category: "software",
      justification: "Team plan upgrade",
    });
    expect(pending.status).toBe("pending_approval");

    const page = await get("/dashboard");
    const html = await page.text();
    expect(html).toContain("Enterprise SaaS Ltd");
    expect(html).toContain("Pending approvals (1)");

    const decide = await postForm("/dashboard/decide", {
      request_id: pending.request_id,
      action: "approve",
    });
    expect(decide.status).toBe(302);

    const check = await session.call("check_approval", {
      request_id: pending.request_id,
    });
    expect(check.status).toBe("approved");
    expect(check.approver).toBe(APPROVER);
  });

  it("exports the ledger as CSV", async () => {
    const res = await get("/dashboard/ledger.csv");
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("id,created_at,agent_id,vendor");
    expect(csv).toContain("Enterprise SaaS Ltd");
  });

  it("saves a new policy version", async () => {
    const newRules: PolicyRules = { ...POLICY, maxPerTransactionCents: 300_00 };
    const res = await postForm("/dashboard/policy", {
      rules: JSON.stringify(newRules),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/policy?saved=2");

    const active = await env.DB.prepare(
      "SELECT MAX(version) AS v FROM policies WHERE org_id = ?"
    )
      .bind(orgId)
      .first<{ v: number }>();
    expect(active!.v).toBe(2);
  });

  it("rejects invalid policy JSON", async () => {
    const res = await postForm("/dashboard/policy", { rules: "{not json" });
    expect(res.status).toBe(400);
  });

  it("creates and revokes agent keys", async () => {
    const created = await postForm("/dashboard/keys/create", {
      agent_id: "second-agent",
    });
    expect(created.status).toBe(200);
    const html = await created.text();
    const newKey = html.match(/vs_[A-Za-z0-9_-]+/)?.[0];
    expect(newKey).toBeTruthy();

    // The fresh key authenticates...
    expect(await new McpSession(newKey!).initialize()).toBe(200);

    // ...until revoked.
    const keyRow = await env.DB.prepare(
      "SELECT id FROM agent_keys WHERE org_id = ? AND agent_id = 'second-agent'"
    )
      .bind(orgId)
      .first<{ id: string }>();
    await postForm("/dashboard/keys/revoke", { key_id: keyRow!.id });
    expect(await new McpSession(newKey!).initialize()).toBe(401);
  });

  it("reports ledger integrity on the audit page", async () => {
    const res = await get("/dashboard/audit");
    const html = await res.text();
    expect(html).toContain("Hash chain verified");
  });
});
