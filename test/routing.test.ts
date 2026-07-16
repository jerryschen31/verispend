import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ADMIN = "admin@routing.test";
const LEAD_ONE = "lead1@routing.test";
const LEAD_TWO = "lead2@routing.test";

const POLICY: PolicyRules = {
  currency: "USD",
  escalation: { amountCents: 50_00 },
  budgets: { perAgent: { dailyCents: 500_00 } },
};

let orgId: string;

const adminPost = async (path: string, body: unknown) => {
  const res = await SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json<any>();
};

const mintAgent = async (org: string, agentId: string) => {
  const { api_key } = await adminPost(`/api/admin/orgs/${org}/keys`, {
    agent_id: agentId,
  });
  const session = new McpSession(api_key);
  expect(await session.initialize()).toBe(200);
  return session;
};

const escalate = async (session: McpSession, vendor: string) => {
  const res = await session.call("request_purchase", {
    vendor,
    amount_cents: 60_00,
    currency: "USD",
    category: "software",
    justification: "annual license",
  });
  expect(res.status).toBe("pending_approval");
  return res.request_id as string;
};

const tokensFor = async (requestId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT token, recipient_email FROM decision_tokens WHERE request_id = ? ORDER BY recipient_email"
  )
    .bind(requestId)
    .all<{ token: string; recipient_email: string }>();
  return results;
};

const routedEvent = async (requestId: string) => {
  const row = await env.DB.prepare(
    "SELECT payload_json FROM ledger_events WHERE request_id = ? AND event_type = 'approval_routed'"
  )
    .bind(requestId)
    .first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) : null;
};

const humanDecisionEvent = async (requestId: string) => {
  const row = await env.DB.prepare(
    "SELECT payload_json FROM ledger_events WHERE request_id = ? AND event_type = 'human_decision'"
  )
    .bind(requestId)
    .first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) : null;
};

beforeAll(async () => {
  const org = await provisionOrg({
    name: "Routing Org",
    agentId: "seed-agent",
    approverEmail: ADMIN,
    policy: POLICY,
  });
  orgId = org.orgId;
  await adminPost(`/api/admin/orgs/${orgId}/members`, {
    email: LEAD_ONE,
    role: "approver",
  });
  await adminPost(`/api/admin/orgs/${orgId}/members`, {
    email: LEAD_TWO,
    role: "approver",
  });
  await adminPost(`/api/admin/orgs/${orgId}/members`, {
    email: "watcher@routing.test",
    role: "viewer",
  });
  await adminPost(`/api/admin/orgs/${orgId}/teams`, {
    name: "ops",
    agent_ids: ["ops-a"],
    approver_emails: [LEAD_ONE, LEAD_TWO],
  });
  await adminPost(`/api/admin/orgs/${orgId}/teams`, {
    name: "leaderless",
    agent_ids: ["lone-a"],
  });
});

describe("approval routing", () => {
  it("routes a teamed agent's escalation to its team approvers, one token each", async () => {
    const agent = await mintAgent(orgId, "ops-a");
    const requestId = await escalate(agent, "Ops Vendor");

    const tokens = await tokensFor(requestId);
    expect(tokens.map((t) => t.recipient_email)).toEqual([LEAD_ONE, LEAD_TWO]);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(2);

    expect(await routedEvent(requestId)).toEqual({
      recipients: [LEAD_ONE, LEAD_TWO],
      source: "team",
    });

    // The click attributes the decision to the specific recipient.
    const leadTwoToken = tokens.find((t) => t.recipient_email === LEAD_TWO)!;
    const page = await SELF.fetch(
      `http://example.com/decide/${leadTwoToken.token}/approve`
    );
    expect(page.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT approver, status FROM purchase_requests WHERE id = ?"
    )
      .bind(requestId)
      .first<{ approver: string; status: string }>();
    expect(row).toEqual({ approver: LEAD_TWO, status: "approved" });
    expect(await humanDecisionEvent(requestId)).toMatchObject({
      decision: "approved",
      approver: LEAD_TWO,
      via: "email_link",
    });

    // The other recipient's token now reports "already decided".
    const leadOneToken = tokens.find((t) => t.recipient_email === LEAD_ONE)!;
    const again = await SELF.fetch(
      `http://example.com/decide/${leadOneToken.token}/approve`
    );
    expect(again.status).toBe(410);
  });

  it("falls back to org admins and approvers for a team with none", async () => {
    const agent = await mintAgent(orgId, "lone-a");
    const requestId = await escalate(agent, "Lone Vendor");
    const routed = await routedEvent(requestId);
    expect(routed.source).toBe("org");
    expect(routed.recipients.sort()).toEqual([ADMIN, LEAD_ONE, LEAD_TWO]);
    expect(routed.recipients).not.toContain("watcher@routing.test");
  });

  it("falls back to org routing for a teamless agent", async () => {
    const agent = await mintAgent(orgId, "teamless-a");
    const requestId = await escalate(agent, "Teamless Vendor");
    expect((await routedEvent(requestId)).source).toBe("org");
  });

  it("uses the legacy approver_email when an org has no members", async () => {
    const legacyEmail = "legacy@routing.test";
    const legacy = await provisionOrg({
      name: "Legacy Routing Org",
      agentId: "legacy-a",
      approverEmail: legacyEmail,
      policy: POLICY,
    });
    await env.DB.prepare("DELETE FROM org_members WHERE org_id = ?")
      .bind(legacy.orgId)
      .run();

    const agent = new McpSession(legacy.apiKey);
    expect(await agent.initialize()).toBe(200);
    const requestId = await escalate(agent, "Legacy Vendor");
    expect(await routedEvent(requestId)).toEqual({
      recipients: [legacyEmail],
      source: "legacy",
    });

    const [token] = await tokensFor(requestId);
    await SELF.fetch(`http://example.com/decide/${token.token}/deny`);
    const row = await env.DB.prepare(
      "SELECT approver, status FROM purchase_requests WHERE id = ?"
    )
      .bind(requestId)
      .first<{ approver: string; status: string }>();
    expect(row).toEqual({ approver: legacyEmail, status: "denied" });
  });

  it("still resolves pre-migration single-token requests (legacy column)", async () => {
    const requestId = `pr_${crypto.randomUUID()}`;
    const legacyToken = `dt_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO purchase_requests
         (id, org_id, agent_id, vendor, amount_cents, currency, category,
          justification, status, policy_version, rule_fired, decision_token)
       VALUES (?, ?, 'old-agent', 'Old Vendor', 6000, 'USD', 'software',
               'pre-deploy request', 'pending_approval', 1, 'escalation_amount', ?)`
    )
      .bind(requestId, orgId, legacyToken)
      .run();

    const page = await SELF.fetch(
      `http://example.com/decide/${legacyToken}/deny`
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Denied");
    expect(await humanDecisionEvent(requestId)).toMatchObject({
      decision: "denied",
      approver: ADMIN, // legacy attribution: the org's approver_email
      via: "email_link",
    });
  });

  it("attributes dashboard decisions to the session member", async () => {
    const agent = await mintAgent(orgId, "ops-a");
    const requestId = await escalate(agent, "Dashboard Decided Vendor");

    const cookie = `${SESSION_COOKIE}=${await signToken("test-session-secret", {
      purpose: "session",
      email: LEAD_ONE,
      orgId,
      exp: Date.now() + SESSION_TTL_MS,
    })}`;
    const res = await SELF.fetch("http://example.com/dashboard/decide", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, action: "deny" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(await humanDecisionEvent(requestId)).toMatchObject({
      decision: "denied",
      approver: LEAD_ONE,
      via: "dashboard",
    });
  });
});
