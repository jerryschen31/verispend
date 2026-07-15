import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ADMIN = "admin@teams.test";

// Generous agent/org limits so the team budget is the binding constraint.
const POLICY: PolicyRules = {
  currency: "USD",
  escalation: { amountCents: 80_00 },
  budgets: {
    perAgent: { dailyCents: 500_00 },
    org: { dailyCents: 1000_00 },
  },
};

const adminPost = async (path: string, body: unknown) => {
  const res = await SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json<any>() };
};

const mintAgent = async (orgId: string, agentId: string) => {
  const { status, body } = await adminPost(`/api/admin/orgs/${orgId}/keys`, {
    agent_id: agentId,
  });
  expect(status).toBe(200);
  const session = new McpSession(body.api_key);
  expect(await session.initialize()).toBe(200);
  return session;
};

const mintCookie = async (email: string, orgId: string) => {
  const session = await signToken("test-session-secret", {
    purpose: "session",
    email,
    orgId,
    exp: Date.now() + SESSION_TTL_MS,
  });
  return `${SESSION_COOKIE}=${session}`;
};

const postForm = (path: string, cookie: string, fields: Record<string, string>) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

const buy = (
  session: McpSession,
  amountCents: number,
  over: Record<string, unknown> = {}
) =>
  session.call("request_purchase", {
    vendor: "Data Vendor Inc",
    amount_cents: amountCents,
    currency: "USD",
    category: "data",
    justification: "enrichment batch",
    ...over,
  });

describe("shared team budgets end to end", () => {
  let orgId: string;
  let teamId: string;
  let agentA: McpSession;
  let agentB: McpSession;
  let solo: McpSession;

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Teams Org",
      agentId: "seed-agent",
      approverEmail: ADMIN,
      policy: POLICY,
    });
    orgId = org.orgId;

    const created = await adminPost(`/api/admin/orgs/${orgId}/teams`, {
      name: "research",
      agent_ids: ["res-a", "res-b"],
      budgets: { dailyCents: 30_00 },
    });
    expect(created.status).toBe(200);
    teamId = created.body.team_id;
    expect(created.body.policy_version).toBe(2);

    agentA = await mintAgent(orgId, "res-a");
    agentB = await mintAgent(orgId, "res-b");
    solo = await mintAgent(orgId, "solo-agent");
  });

  it("denies a teammate once the shared budget is exhausted", async () => {
    const first = await buy(agentA, 20_00);
    expect(first.status).toBe("approved");

    const second = await buy(agentB, 15_00, { vendor: "Other Vendor" });
    expect(second.status).toBe("denied");
    expect(second.rule_fired).toBe("budget_team_daily");
    expect(second.reason).toContain('team "research" daily');
  });

  it("reports team budget status to teamed agents, null to others", async () => {
    const teamed = await agentB.call("get_budget_status", {});
    expect(teamed.team).toMatchObject({
      id: teamId,
      name: "research",
      daily_used_cents: 20_00,
      daily_limit_cents: 30_00,
    });

    const alone = await solo.call("get_budget_status", {});
    expect(alone.team).toBeNull();
  });

  it("keeps the shared budget atomic under a concurrent multi-agent race", async () => {
    const org = await provisionOrg({
      name: "Teams Race Org",
      agentId: "race-seed",
      policy: POLICY,
    });
    await adminPost(`/api/admin/orgs/${org.orgId}/teams`, {
      name: "race",
      agent_ids: ["race-a", "race-b"],
      budgets: { dailyCents: 30_00 },
    });
    const a = await mintAgent(org.orgId, "race-a");
    const b = await mintAgent(org.orgId, "race-b");

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        buy(i % 2 === 0 ? a : b, 10_00, { vendor: `Race Vendor ${i}` })
      )
    );
    const approved = results.filter((r) => r.status === "approved");
    const denied = results.filter((r) => r.status === "denied");
    expect(approved).toHaveLength(3); // 3 × $10 fills the $30 team cap
    expect(denied).toHaveLength(3);
    for (const d of denied) expect(d.rule_fired).toBe("budget_team_daily");

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM purchase_requests WHERE org_id = ? AND status = 'approved'"
    )
      .bind(org.orgId)
      .first<{ n: number }>();
    expect(count?.n).toBe(3);
  });

  it("re-checks the team budget at human-approval time", async () => {
    // Escalates (>= $80) so no budget is reserved yet.
    const pending = await buy(agentA, 80_00, { vendor: "Big Purchase Co" });
    expect(pending.status).toBe("pending_approval");

    // A teammate exhausts the remaining $10 of the team budget meanwhile.
    const filler = await buy(agentB, 10_00, { vendor: "Filler Vendor" });
    expect(filler.status).toBe("approved");

    const cookie = await mintCookie(ADMIN, orgId);
    const decide = await postForm("/dashboard/decide", cookie, {
      request_id: pending.request_id,
      action: "approve",
    });
    expect(decide.status).toBe(302);

    const check = await agentA.call("check_approval", {
      request_id: pending.request_id,
    });
    expect(check.status).toBe("denied");
    expect(check.reason).toContain('team "research" daily');
  });

  it("does not apply team budgets to requests pinned to older policy versions", async () => {
    const org = await provisionOrg({
      name: "Pinned Org",
      agentId: "pin-seed",
      approverEmail: "admin@pinned.test",
      policy: { ...POLICY, escalation: { amountCents: 50_00 } },
    });
    // Team without budgets: policy stays at v1.
    const created = await adminPost(`/api/admin/orgs/${org.orgId}/teams`, {
      name: "ops",
      agent_ids: ["ops-a"],
    });
    const opsTeam = created.body.team_id;
    const agent = await mintAgent(org.orgId, "ops-a");

    const pending = await buy(agent, 60_00, { vendor: "Pinned Vendor" });
    expect(pending.status).toBe("pending_approval");

    // v2 adds a team budget far too small for the pending purchase.
    const cookie = await mintCookie("admin@pinned.test", org.orgId);
    const budget = await postForm(`/dashboard/teams/${opsTeam}/budget`, cookie, {
      daily_cents: "500",
      monthly_cents: "",
    });
    expect(budget.status).toBe(302);
    const active = await env.DB.prepare(
      "SELECT MAX(version) AS v, rules_json FROM policies WHERE org_id = ?"
    )
      .bind(org.orgId)
      .first<{ v: number; rules_json: string }>();
    expect(active?.v).toBe(2);
    expect(JSON.parse(active!.rules_json).budgets.teams[opsTeam]).toEqual({
      dailyCents: 500,
    });

    // Approval evaluates under the pinned v1, which has no team budget.
    const decide = await postForm("/dashboard/decide", cookie, {
      request_id: pending.request_id,
      action: "approve",
    });
    expect(decide.status).toBe(302);
    const check = await agent.call("check_approval", {
      request_id: pending.request_id,
    });
    expect(check.status).toBe("approved");
  });

  it("gates team management to admins", async () => {
    const viewerEmail = "viewer@teams.test";
    await adminPost(`/api/admin/orgs/${orgId}/members`, {
      email: viewerEmail,
      role: "viewer",
    });
    const viewer = await mintCookie(viewerEmail, orgId);
    expect(
      (await postForm("/dashboard/teams", viewer, { name: "sneaky" })).status
    ).toBe(403);
    expect(
      (
        await postForm(`/dashboard/teams/${teamId}/budget`, viewer, {
          daily_cents: "1",
          monthly_cents: "",
        })
      ).status
    ).toBe(403);

    // Viewers can still read the teams pages.
    const page = await SELF.fetch(`http://example.com/dashboard/teams`, {
      headers: { cookie: viewer },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("research");
  });
});
