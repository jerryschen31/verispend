import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  resolveAgentLimits,
  type PolicyRules,
  type PurchaseIntent,
} from "../src/policy";

const rules: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 500_00,
  vendors: { deny: ["Shady Vendor Inc"] },
  categories: { deny: ["gambling"] },
  escalation: { amountCents: 200_00, categories: ["travel"] },
  budgets: {
    org: { dailyCents: 1000_00 },
    perAgent: { dailyCents: 300_00 },
    agents: { "big-spender": { dailyCents: 800_00 } },
  },
};

const intent = (overrides: Partial<PurchaseIntent>): PurchaseIntent => ({
  agentId: "agent-1",
  vendor: "Acme API Co",
  amountCents: 50_00,
  currency: "USD",
  category: "software",
  justification: "Monthly data enrichment credits",
  ...overrides,
});

describe("evaluatePolicy", () => {
  it("approves a purchase within all limits", () => {
    expect(evaluatePolicy(rules, intent({}))).toEqual({
      decision: "approved",
      ruleFired: "within_policy",
    });
  });

  it("denies non-positive and non-integer amounts", () => {
    expect(evaluatePolicy(rules, intent({ amountCents: 0 })).decision).toBe(
      "denied"
    );
    expect(evaluatePolicy(rules, intent({ amountCents: -5 })).decision).toBe(
      "denied"
    );
    expect(
      evaluatePolicy(rules, intent({ amountCents: 10.5 })).ruleFired
    ).toBe("invalid_amount");
  });

  it("denies currency mismatch", () => {
    const result = evaluatePolicy(rules, intent({ currency: "EUR" }));
    expect(result).toMatchObject({
      decision: "denied",
      ruleFired: "currency_mismatch",
    });
  });

  it("denies vendors on the deny list, case-insensitively", () => {
    const result = evaluatePolicy(
      rules,
      intent({ vendor: "  shady vendor inc " })
    );
    expect(result).toMatchObject({
      decision: "denied",
      ruleFired: "vendor_denied",
    });
  });

  it("enforces a vendor allow list when present", () => {
    const allowRules: PolicyRules = {
      ...rules,
      vendors: { allow: ["Acme API Co"] },
    };
    expect(evaluatePolicy(allowRules, intent({})).decision).toBe("approved");
    expect(
      evaluatePolicy(allowRules, intent({ vendor: "Other Corp" }))
    ).toMatchObject({ decision: "denied", ruleFired: "vendor_not_allowed" });
  });

  it("denies categories on the deny list before considering escalation", () => {
    const result = evaluatePolicy(
      { ...rules, escalation: { categories: ["gambling"] } },
      intent({ category: "gambling" })
    );
    expect(result).toMatchObject({
      decision: "denied",
      ruleFired: "category_denied",
    });
  });

  it("denies amounts over the per-transaction cap even if they would escalate", () => {
    const result = evaluatePolicy(rules, intent({ amountCents: 900_00 }));
    expect(result).toMatchObject({
      decision: "denied",
      ruleFired: "over_transaction_cap",
    });
  });

  it("escalates categories requiring human approval", () => {
    const result = evaluatePolicy(rules, intent({ category: "Travel" }));
    expect(result).toMatchObject({
      decision: "pending_approval",
      ruleFired: "escalation_category",
    });
  });

  it("escalates amounts at or above the threshold", () => {
    expect(
      evaluatePolicy(rules, intent({ amountCents: 200_00 }))
    ).toMatchObject({
      decision: "pending_approval",
      ruleFired: "escalation_amount",
    });
    expect(
      evaluatePolicy(rules, intent({ amountCents: 199_99 })).decision
    ).toBe("approved");
  });
});

describe("resolveAgentLimits", () => {
  it("prefers per-agent overrides, falling back to the default", () => {
    expect(resolveAgentLimits(rules, "big-spender")).toEqual({
      dailyCents: 800_00,
    });
    expect(resolveAgentLimits(rules, "agent-1")).toEqual({
      dailyCents: 300_00,
    });
  });
});
