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

  it("surfaces frozen agents and unfreezes them", async () => {
    // Freeze an agent directly via the coordinator (breaker-flow tests cover
    // tripping through MCP traffic).
    const coordinator = env.ORG.getByName(orgId);
    const rules = {
      enabled: true,
      identical: { count: 2, windowMinutes: 10 },
      velocity: { count: 100, windowMinutes: 5 },
      acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 1_000_00 },
    };
    const args = {
      agentId: "dash-agent",
      vendor: "LoopMart",
      amountCents: 2_00,
      category: "data",
      breakerRules: rules,
    };
    await coordinator.recordAndCheck(args);
    const second = await coordinator.recordAndCheck(args);
    expect(second.status).toBe("tripped");

    // Overview banner and keys page both show the freeze.
    expect(await (await get("/dashboard")).text()).toContain("frozen agent");
    const keysHtml = await (await get("/dashboard/keys")).text();
    expect(keysHtml).toContain("Frozen agents");
    expect(keysHtml).toContain("LoopMart");

    // Unfreeze via the dashboard.
    const res = await postForm("/dashboard/agents/unfreeze", {
      agent_id: "dash-agent",
    });
    expect(res.status).toBe(302);
    expect(await coordinator.isFrozen({ agentId: "dash-agent" })).toEqual({
      frozen: false,
    });
    expect(await (await get("/dashboard/keys")).text()).not.toContain(
      "Frozen agents"
    );

    // The reset landed on the ledger.
    const reset = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND event_type = 'breaker_reset'"
    )
      .bind(orgId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(reset!.payload_json)).toMatchObject({
      agentId: "dash-agent",
      unfrozenBy: APPROVER,
    });
  });

  it("enters a bill on the reconciliation page and shows the verdict", async () => {
    const session = new McpSession(apiKey);
    await session.initialize();
    await session.call("record_usage", {
      vendor: "ComputeCo",
      metric: "gpu_hours",
      units: 3,
      expected_cost_cents: 24_00,
    });

    const today = new Date().toISOString().slice(0, 10);
    const res = await postForm("/dashboard/bills", {
      vendor: "ComputeCo",
      period_start: today,
      period_end: today,
      amount_cents: "3600",
      memo: "double-charged retries",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/reconciliation");

    const html = await (await get("/dashboard/reconciliation")).text();
    expect(html).toContain("ComputeCo");
    expect(html).toContain("overbilled");
    expect(html).toContain("gpu_hours");

    // Invalid input round-trips as an error message, not a 500.
    const bad = await postForm("/dashboard/bills", {
      vendor: "ComputeCo",
      period_start: "yesterday",
      period_end: today,
      amount_cents: "100",
    });
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("error=");
  });

  it("reports ledger integrity on the audit page", async () => {
    const res = await get("/dashboard/audit");
    const html = await res.text();
    expect(html).toContain("Hash chain verified");
  });
});

describe("phase 3 pages: settlements, issuers, receipts", () => {
  let viewerCookie: string;

  beforeAll(async () => {
    await SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": "test-admin-key",
      },
      body: JSON.stringify({ email: "viewer@example.com", role: "viewer" }),
    });
    viewerCookie = `${SESSION_COOKIE}=${await signToken("test-session-secret", {
      purpose: "session",
      email: "viewer@example.com",
      orgId,
      exp: Date.now() + SESSION_TTL_MS,
    })}`;
  });

  it("ingests a settlement from the form and renders the match", async () => {
    const res = await postForm("/dashboard/settlements", {
      rail: "card",
      settlement_ref: "AUTH-DASH",
      vendor: "Rogue Dashboard Vendor",
      amount_cents: "4200",
      currency: "USD",
      occurred_at: "2026-07-15T10:00",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/settlements");

    const html = await (await get("/dashboard/settlements")).text();
    expect(html).toContain("AUTH-DASH");
    expect(html).toContain("Rogue Dashboard Vendor");
    expect(html).toContain("unauthorized");

    // Invalid input round-trips as an error message, not a 500.
    const bad = await postForm("/dashboard/settlements", {
      rail: "card",
      settlement_ref: "",
      vendor: "X",
      amount_cents: "100",
      occurred_at: "2026-07-15T10:00",
    });
    expect(bad.headers.get("location")).toContain("error=");
  });

  it("keeps viewers read-only on settlements", async () => {
    const page = await SELF.fetch("http://example.com/dashboard/settlements", {
      headers: { cookie: viewerCookie },
    });
    expect(page.status).toBe(200);

    const post = await SELF.fetch("http://example.com/dashboard/settlements", {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ rail: "card" }).toString(),
    });
    expect(post.status).toBe(403);
  });

  it("registers and revokes a trusted issuer (admin only)", async () => {
    const register = await postForm("/dashboard/issuers", {
      issuer: "https://dash-issuer.test",
      scheme: "ap2",
      alg: "Ed25519",
      public_key_jwk: JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: "SDZ-jN-bJlQ6miAQfnvK62RvyJ4griojJEUkASJJW1I",
      }),
    });
    expect(register.status).toBe(302);

    let html = await (await get("/dashboard/issuers")).text();
    expect(html).toContain("https://dash-issuer.test");
    expect(html).toContain("active");

    const issuerId = html.match(/name="issuer_id" value="(iss_[^"]+)"/)?.[1];
    expect(issuerId).toBeTruthy();
    const revoke = await postForm("/dashboard/issuers/revoke", {
      issuer_id: issuerId!,
    });
    expect(revoke.status).toBe(302);
    html = await (await get("/dashboard/issuers")).text();
    expect(html).toContain("revoked");

    // Bad JWK round-trips as an error; non-admins are forbidden.
    const bad = await postForm("/dashboard/issuers", {
      issuer: "x",
      scheme: "ap2",
      alg: "Ed25519",
      public_key_jwk: "not json",
    });
    expect(bad.headers.get("location")).toContain("error=");
    const forbidden = await SELF.fetch("http://example.com/dashboard/issuers", {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ issuer: "x" }).toString(),
    });
    expect(forbidden.status).toBe(403);
  });

  it("issues a receipt from the request detail page and serves the download", async () => {
    const session = new McpSession(apiKey);
    expect(await session.initialize()).toBe(200);
    const purchase = await session.call("request_purchase", {
      vendor: "Receipt Dash Vendor",
      amount_cents: 12_00,
      currency: "USD",
      category: "software",
      justification: "dashboard receipt test",
    });
    expect(purchase.status).toBe("approved");

    let html = await (await get(`/dashboard/requests/${purchase.request_id}`)).text();
    expect(html).toContain("No receipt issued yet");
    expect(html).toContain("Issue signed receipt");

    const issue = await postForm(`/dashboard/requests/${purchase.request_id}/receipt`, {});
    expect(issue.status).toBe(302);

    html = await (await get(`/dashboard/requests/${purchase.request_id}`)).text();
    expect(html).toContain("Reissue signed receipt");
    expect(html).toContain("download");

    const download = await get(
      `/dashboard/requests/${purchase.request_id}/receipt.json`
    );
    expect(download.status).toBe(200);
    const receipt = await download.json<{
      format: string;
      payload_json: string;
    }>();
    expect(receipt.format).toBe("verispend-receipt");
    expect(JSON.parse(receipt.payload_json).request.vendor).toBe(
      "Receipt Dash Vendor"
    );

    // Viewers can read but not issue.
    const forbidden = await SELF.fetch(
      `http://example.com/dashboard/requests/${purchase.request_id}/receipt`,
      { method: "POST", headers: { cookie: viewerCookie } }
    );
    expect(forbidden.status).toBe(403);
  });

  it("shows mandate and settlement panels on the request detail page", async () => {
    const session = new McpSession(apiKey);
    expect(await session.initialize()).toBe(200);
    const purchase = await session.call("request_purchase", {
      vendor: "Panel Vendor",
      amount_cents: 18_00,
      currency: "USD",
      category: "software",
      justification: "panel test",
    });
    await session.call("record_outcome", {
      request_id: purchase.request_id,
      final_amount_cents: 18_00,
      rail: "card",
      settlement_ref: "AUTH-PANEL",
    });
    await postForm("/dashboard/settlements", {
      rail: "card",
      settlement_ref: "AUTH-PANEL",
      vendor: "Panel Vendor",
      amount_cents: "1800",
      currency: "USD",
      occurred_at: "2026-07-15T10:00",
    });

    const html = await (await get(`/dashboard/requests/${purchase.request_id}`)).text();
    expect(html).toContain("Settlement");
    expect(html).toContain("AUTH-PANEL");
    expect(html).toContain("matched");
    expect(html).toContain("Reported settlement");
  });
});
