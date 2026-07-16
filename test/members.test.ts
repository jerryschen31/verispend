import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { getFirstMembershipByEmail } from "../src/db";
import { provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ADMIN = "cfo@members.test";
const APPROVER = "lead@members.test";
const VIEWER = "auditor@members.test";

const POLICY: PolicyRules = {
  currency: "USD",
  escalation: { amountCents: 100_00 },
  budgets: { perAgent: { dailyCents: 500_00 } },
};

let orgId: string;

const mintCookie = async (email: string, forOrgId = orgId) => {
  const session = await signToken("test-session-secret", {
    purpose: "session",
    email,
    orgId: forOrgId,
    exp: Date.now() + SESSION_TTL_MS,
  });
  return `${SESSION_COOKIE}=${session}`;
};

const get = async (path: string, cookie: string) =>
  SELF.fetch(`http://example.com${path}`, {
    headers: { cookie },
    redirect: "manual",
  });

const postForm = async (
  path: string,
  cookie: string,
  fields: Record<string, string>
) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

const addMember = async (email: string, role: string, org = orgId) => {
  const res = await SELF.fetch(
    `http://example.com/api/admin/orgs/${org}/members`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": "test-admin-key",
      },
      body: JSON.stringify({ email, role }),
    }
  );
  expect(res.status).toBe(200);
  return res.json<{ member_id: string }>();
};

beforeAll(async () => {
  const org = await provisionOrg({
    name: "Members Org",
    agentId: "members-agent",
    approverEmail: ADMIN,
    policy: POLICY,
  });
  orgId = org.orgId;
  await addMember(APPROVER, "approver");
  await addMember(VIEWER, "viewer");
});

describe("membership model", () => {
  it("seeds the org approver email as an admin member", async () => {
    const row = await env.DB.prepare(
      "SELECT email, role FROM org_members WHERE org_id = ? AND email = ?"
    )
      .bind(orgId, ADMIN)
      .first<{ email: string; role: string }>();
    expect(row).toMatchObject({ email: ADMIN, role: "admin" });
  });

  it("normalizes emails to lower(trim()) on write and lookup", async () => {
    await addMember("  Mixed.Case@Members.Test  ", "viewer");
    const row = await env.DB.prepare(
      "SELECT email FROM org_members WHERE org_id = ? AND email = ?"
    )
      .bind(orgId, "mixed.case@members.test")
      .first<{ email: string }>();
    expect(row?.email).toBe("mixed.case@members.test");
  });

  it("picks the oldest membership for an email in multiple orgs", async () => {
    const other = await provisionOrg({
      name: "Members Org Two",
      agentId: "members-agent-2",
      policy: POLICY,
    });
    const shared = "shared@members.test";
    await env.DB.prepare(
      `INSERT INTO org_members (id, org_id, email, role, created_at)
       VALUES (?, ?, ?, 'viewer', '2026-01-02T00:00:00Z'),
              (?, ?, ?, 'admin', '2026-01-01T00:00:00Z')`
    )
      .bind(
        `mem_${crypto.randomUUID()}`,
        orgId,
        shared,
        `mem_${crypto.randomUUID()}`,
        other.orgId,
        shared
      )
      .run();
    const first = await getFirstMembershipByEmail(env.DB, shared);
    expect(first?.org_id).toBe(other.orgId);
    expect(first?.role).toBe("admin");
  });
});

describe("Kinde login via membership", () => {
  const realFetch = globalThis.fetch;
  let tokenEmail: string;
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://test-kinde.example/oauth2/token") {
        const b64url = (obj: unknown) =>
          btoa(JSON.stringify(obj))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
        const idToken = [
          b64url({ alg: "RS256", typ: "JWT" }),
          b64url({
            iss: "https://test-kinde.example",
            aud: "test-client-id",
            exp: Math.floor(Date.now() / 1000) + 3600,
            email: tokenEmail,
          }),
          "sig",
        ].join(".");
        return Response.json({ id_token: idToken });
      }
      return realFetch(input as any, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const loginAs = async (email: string) => {
    tokenEmail = email;
    const login = await SELF.fetch("http://example.com/auth/login", {
      redirect: "manual",
    });
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state"
    )!;
    const stateCookie = login.headers.get("set-cookie")!.split(";")[0];
    return SELF.fetch(
      `http://example.com/auth/callback?code=fake-code&state=${state}`,
      { headers: { cookie: stateCookie }, redirect: "manual" }
    );
  };

  it("logs in a viewer member", async () => {
    const callback = await loginAs(VIEWER);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
  });

  it("rejects a non-member", async () => {
    const callback = await loginAs("stranger@members.test");
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("No org for this account");
  });

  it("falls back to legacy approver_email and promotes it to admin member", async () => {
    // Simulate an org created before the members migration: approver_email
    // set, but no member row.
    const legacyEmail = "legacy@members.test";
    const legacy = await provisionOrg({
      name: "Legacy Org",
      agentId: "legacy-agent",
      approverEmail: legacyEmail,
      policy: POLICY,
    });
    await env.DB.prepare("DELETE FROM org_members WHERE org_id = ?")
      .bind(legacy.orgId)
      .run();

    const callback = await loginAs(legacyEmail);
    expect(callback.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT role FROM org_members WHERE org_id = ? AND email = ?"
    )
      .bind(legacy.orgId, legacyEmail)
      .first<{ role: string }>();
    expect(row?.role).toBe("admin");
  });
});

describe("role enforcement", () => {
  it("revokes access immediately when a member is removed", async () => {
    const gone = "removed@members.test";
    await addMember(gone, "viewer");
    const cookie = await mintCookie(gone);
    expect((await get("/dashboard", cookie)).status).toBe(200);

    await env.DB.prepare(
      "DELETE FROM org_members WHERE org_id = ? AND email = ?"
    )
      .bind(orgId, gone)
      .run();
    const res = await get("/dashboard", cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("enforces the role matrix on POST routes", async () => {
    const admin = await mintCookie(ADMIN);
    const approver = await mintCookie(APPROVER);
    const viewer = await mintCookie(VIEWER);

    // Viewer: no deciding, no policy edits, no member management.
    expect(
      (await postForm("/dashboard/decide", viewer, { request_id: "x", action: "deny" })).status
    ).toBe(403);
    expect(
      (await postForm("/dashboard/policy", viewer, { rules: "{}" })).status
    ).toBe(403);
    expect(
      (await postForm("/dashboard/members", viewer, { email: "x@y.z", role: "viewer" })).status
    ).toBe(403);
    expect(
      (await postForm("/dashboard/keys/create", viewer, { agent_id: "nope" })).status
    ).toBe(403);

    // Approver: can decide, cannot administer.
    expect(
      (await postForm("/dashboard/decide", approver, { request_id: "missing", action: "deny" })).status
    ).toBe(302);
    expect(
      (await postForm("/dashboard/policy", approver, { rules: "{}" })).status
    ).toBe(403);
    expect(
      (await postForm("/dashboard/keys/create", approver, { agent_id: "nope" })).status
    ).toBe(403);
    expect(
      (await postForm("/dashboard/agents/unfreeze", approver, { agent_id: "x" })).status
    ).toBe(403);

    // Admin: can administer.
    expect(
      (await postForm("/dashboard/policy", admin, { rules: JSON.stringify(POLICY) })).status
    ).toBe(302);
  });

  it("hides approve/deny actions from viewers", async () => {
    const viewer = await mintCookie(VIEWER);
    const html = await (await get("/dashboard", viewer)).text();
    expect(html).not.toContain('action="/dashboard/decide"');
  });
});

describe("members page", () => {
  it("lets an admin add, change, and remove members", async () => {
    const admin = await mintCookie(ADMIN);

    const added = await postForm("/dashboard/members", admin, {
      email: "temp@members.test",
      role: "approver",
    });
    expect(added.status).toBe(302);

    const changed = await postForm("/dashboard/members", admin, {
      email: "temp@members.test",
      role: "viewer",
    });
    expect(changed.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT id, role FROM org_members WHERE org_id = ? AND email = 'temp@members.test'"
    )
      .bind(orgId)
      .first<{ id: string; role: string }>();
    expect(row?.role).toBe("viewer");

    const removed = await postForm("/dashboard/members/delete", admin, {
      member_id: row!.id,
    });
    expect(removed.status).toBe(302);
    const goneRow = await env.DB.prepare(
      "SELECT id FROM org_members WHERE org_id = ? AND email = 'temp@members.test'"
    )
      .bind(orgId)
      .first();
    expect(goneRow).toBeNull();
  });

  it("lists members with roles for a viewer, without management forms", async () => {
    const viewer = await mintCookie(VIEWER);
    const html = await (await get("/dashboard/members", viewer)).text();
    expect(html).toContain(ADMIN);
    expect(html).toContain(VIEWER);
    expect(html).not.toContain("Add member");
  });

  it("refuses to demote or remove the last admin", async () => {
    const admin = await mintCookie(ADMIN);

    const demote = await postForm("/dashboard/members", admin, {
      email: ADMIN,
      role: "viewer",
    });
    expect(demote.status).toBe(400);

    const adminRow = await env.DB.prepare(
      "SELECT id FROM org_members WHERE org_id = ? AND email = ?"
    )
      .bind(orgId, ADMIN)
      .first<{ id: string }>();
    const remove = await postForm("/dashboard/members/delete", admin, {
      member_id: adminRow!.id,
    });
    expect(remove.status).toBe(400);
  });
});
