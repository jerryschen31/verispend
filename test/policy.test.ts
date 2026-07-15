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
    expect(evaluatePolicy(rules, intent({}))).toMatchObject({
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

describe("evaluatePolicy trace", () => {
  const ALL_RULES = [
    "invalid_amount",
    "currency_mismatch",
    "vendor_denied",
    "vendor_not_allowed",
    "category_denied",
    "category_not_allowed",
    "over_transaction_cap",
    "escalation_category",
    "escalation_amount",
  ];

  it("emits one entry per rule with nothing triggered on approval", () => {
    const { trace } = evaluatePolicy(rules, intent({}));
    expect(trace.map((t) => t.rule)).toEqual(ALL_RULES);
    expect(trace.every((t) => t.result !== "triggered")).toBe(true);
    // Rules the policy doesn't configure are marked so.
    const vendorAllow = trace.find((t) => t.rule === "vendor_not_allowed");
    expect(vendorAllow).toMatchObject({ result: "skipped", detail: "not configured" });
    // Configured rules that were checked report why they passed.
    const cap = trace.find((t) => t.rule === "over_transaction_cap");
    expect(cap?.result).toBe("pass");
    expect(cap?.detail).toContain("per-transaction cap");
  });

  it("shows pass → triggered → skipped ordering on a denial", () => {
    const { trace, ruleFired } = evaluatePolicy(
      rules,
      intent({ vendor: "Shady Vendor Inc" })
    );
    const triggered = trace.find((t) => t.result === "triggered");
    expect(triggered?.rule).toBe(ruleFired);
    expect(triggered?.detail).toContain("deny list");

    const idx = trace.findIndex((t) => t.result === "triggered");
    expect(trace[1]).toMatchObject({ rule: "currency_mismatch", result: "pass" });
    for (const later of trace.slice(idx + 1)) {
      expect(later).toMatchObject({
        result: "skipped",
        detail: "skipped: decision already made",
      });
    }
  });

  it("records passing entries for every rule ahead of an escalation", () => {
    const { trace } = evaluatePolicy(rules, intent({ amountCents: 250_00 }));
    const triggered = trace.find((t) => t.result === "triggered");
    expect(triggered?.rule).toBe("escalation_amount");
    const before = trace.slice(0, trace.indexOf(triggered!));
    expect(before.every((t) => t.result === "pass" || t.result === "skipped")).toBe(true);
    expect(before.filter((t) => t.result === "pass").length).toBeGreaterThanOrEqual(4);
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
