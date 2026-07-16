import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../src/ledger";
import type { PolicyRules } from "../src/policy";
import { McpSession, provisionOrg } from "./helpers";

// Policy tuned so the breaker trips fast while ordinary purchases sail through.
const POLICY: PolicyRules = {
  currency: "USD",
  budgets: { perAgent: { dailyCents: 10_000_00 }, org: { dailyCents: 50_000_00 } },
  circuitBreaker: {
    identical: { count: 4, windowMinutes: 10 },
    velocity: { count: 50, windowMinutes: 5 },
    acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 10_000_00 },
  },
};

const PURCHASE = {
  vendor: "DataCo",
  amount_cents: 3_00,
  currency: "USD",
  category: "data",
  justification: "Fetch the same dataset (stuck in a loop)",
};

describe("circuit breaker through the MCP endpoint", () => {
  it("freezes a runaway loop, denies further spend, and records it all", async () => {
    const { orgId, apiKey } = await provisionOrg({
      name: "Breaker Corp",
      agentId: "loop-agent",
      policy: POLICY,
    });
    const session = new McpSession(apiKey);
    expect(await session.initialize()).toBe(200);

    // First three identical requests pass policy and get approved.
    for (let i = 0; i < 3; i++) {
      const res = await session.call("request_purchase", PURCHASE);
      expect(res.status).toBe("approved");
    }

    // The 4th identical request trips the breaker.
    const tripped = await session.call("request_purchase", PURCHASE);
    expect(tripped.status).toBe("denied");
    expect(tripped.rule_fired).toBe("circuit_breaker");
    expect(tripped.reason).toContain("runaway loop");

    // Once frozen, even a completely different purchase is denied.
    const different = await session.call("request_purchase", {
      ...PURCHASE,
      vendor: "OtherVendor",
      amount_cents: 1_00,
      justification: "Something unrelated",
    });
    expect(different.status).toBe("denied");
    expect(different.rule_fired).toBe("agent_frozen");
    expect(different.reason).toContain("unfreeze");

    // The agent can discover its own state.
    const budget = await session.call("get_budget_status", {});
    expect(budget.frozen).toBe(true);
    expect(budget.frozen_reason).toContain("runaway loop");

    // Frozen denials never consumed budget: only the 3 approvals did.
    expect(budget.agent.daily_used_cents).toBe(9_00);

    // The trip is on the tamper-evident record, and the chain still verifies.
    const { results } = await env.DB.prepare(
      "SELECT event_type FROM ledger_events WHERE org_id = ? ORDER BY seq"
    )
      .bind(orgId)
      .all<{ event_type: string }>();
    const types = results.map((r) => r.event_type);
    expect(types).toContain("breaker_tripped");
    expect(await verifyLedgerChain(env.DB, orgId)).toMatchObject({ ok: true });

    // Unfreezing via the org coordinator restores purchasing for new patterns.
    await env.ORG.getByName(orgId).unfreeze({ agentId: "loop-agent" });
    const after = await session.call("request_purchase", {
      ...PURCHASE,
      vendor: "FreshVendor",
      justification: "Back to normal work",
    });
    expect(after.status).toBe("approved");
  });

  it("keeps the breaker out of the way of a well-behaved agent", async () => {
    const { apiKey } = await provisionOrg({
      name: "Calm Corp",
      agentId: "calm-agent",
      policy: POLICY,
    });
    const session = new McpSession(apiKey);
    await session.initialize();

    const vendors = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    for (const vendor of vendors) {
      const res = await session.call("request_purchase", {
        ...PURCHASE,
        vendor,
        justification: `Buy from ${vendor}`,
      });
      expect(res.status).toBe("approved");
    }
    const budget = await session.call("get_budget_status", {});
    expect(budget.frozen).toBe(false);
  });
});
