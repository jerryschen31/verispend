import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { verifyLedgerChain } from "../src/ledger";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ADMIN = "admin@trace.test";

const POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 200_00,
  escalation: { amountCents: 150_00 },
  budgets: { perAgent: { dailyCents: 50_00 } },
  circuitBreaker: {
    identical: { count: 3, windowMinutes: 10 },
    velocity: { count: 100, windowMinutes: 5 },
    acceleration: { multiplier: 10, windowMinutes: 60, minSpendCents: 1_000_00 },
  },
};

let orgId: string;
let agent: McpSession;
let deniedRequestId: string;

const buy = (amountCents: number, vendor: string) =>
  agent.call("request_purchase", {
    vendor,
    amount_cents: amountCents,
    currency: "USD",
    category: "data",
    justification: "trace testing",
  });

beforeAll(async () => {
  const org = await provisionOrg({
    name: "Trace Org",
    agentId: "trace-agent",
    approverEmail: ADMIN,
    policy: POLICY,
  });
  orgId = org.orgId;
  agent = new McpSession(org.apiKey);
  expect(await agent.initialize()).toBe(200);
});

describe("explainable decisions end to end", () => {
  it("returns a full trace on approval, including passing budget checks", async () => {
    const res = await buy(20_00, "Vendor One");
    expect(res.status).toBe("approved");
    expect(Array.isArray(res.trace)).toBe(true);

    const rules = res.trace.map((t: { rule: string }) => t.rule);
    expect(rules).toContain("over_transaction_cap");
    expect(rules).toContain("escalation_amount");
    expect(res.trace.some((t: { result: string }) => t.result === "triggered")).toBe(false);

    const budget = res.trace.find(
      (t: { rule: string }) => t.rule === "budget_agent_daily"
    );
    expect(budget?.result).toBe("pass");
    expect(budget?.detail).toContain("0¢ used of 5000¢");

    // The same trace is persisted in the auto_decision ledger payload.
    const event = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND request_id = ? AND event_type = 'auto_decision'"
    )
      .bind(orgId, res.request_id)
      .first<{ payload_json: string }>();
    const payload = JSON.parse(event!.payload_json);
    expect(payload.trace).toEqual(res.trace);
    expect(await verifyLedgerChain(env.DB, orgId)).toMatchObject({ ok: true });
  });

  it("explains budget denials with the failing scope", async () => {
    const res = await buy(40_00, "Vendor Two"); // 20 + 40 > 50 daily cap
    expect(res.status).toBe("denied");
    expect(res.rule_fired).toBe("budget_agent_daily");
    expect(res.budget).toEqual({
      scope: "agent",
      scope_id: "trace-agent",
      period: "daily",
      limit_cents: 50_00,
      used_cents: 20_00,
    });
    const triggered = res.trace.filter(
      (t: { result: string }) => t.result === "triggered"
    );
    expect(triggered).toHaveLength(1);
    expect(triggered[0].rule).toBe("budget_agent_daily");
    deniedRequestId = res.request_id;
  });

  it("gives breaker denials a synthetic trace", async () => {
    // Identical requests: the 3rd trips (count 3), the 4th hits the freeze.
    await buy(1_00, "Loop Vendor");
    await buy(1_00, "Loop Vendor");
    const tripped = await buy(1_00, "Loop Vendor");
    expect(tripped.rule_fired).toBe("circuit_breaker");
    expect(tripped.trace).toEqual([
      { rule: "circuit_breaker", result: "triggered", detail: tripped.reason },
    ]);

    const frozen = await buy(2_00, "Different Vendor");
    expect(frozen.rule_fired).toBe("agent_frozen");
    expect(frozen.trace[0]).toMatchObject({
      rule: "agent_frozen",
      result: "triggered",
    });
  });

  it("renders the trace on the request detail page", async () => {
    const cookie = `${SESSION_COOKIE}=${await signToken("test-session-secret", {
      purpose: "session",
      email: ADMIN,
      orgId,
      exp: Date.now() + SESSION_TTL_MS,
    })}`;
    const res = await SELF.fetch(
      `http://example.com/dashboard/requests/${deniedRequestId}`,
      { headers: { cookie } }
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("budget_agent_daily");
    expect(html).toContain("triggered");
    expect(html).toContain("Ledger timeline");
    expect(html).toContain("Vendor Two");
  });
});
