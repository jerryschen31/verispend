// Deterministic policy evaluation. Pure functions only — budget enforcement
// happens in OrgCoordinator (the per-org Durable Object), because it needs
// atomic counters.

export type BudgetLimits = {
  dailyCents?: number;
  monthlyCents?: number;
};

export type CircuitBreakerRules = {
  /** Breaker is on by default; set false to opt an org out entirely. */
  enabled?: boolean;
  /** Same (vendor, amount, category) repeating: runaway-loop signature. */
  identical?: { count: number; windowMinutes: number };
  /** Total request rate from one agent, regardless of contents. */
  velocity?: { count: number; windowMinutes: number };
  /** Requested spend in the window vs the agent's trailing 24h baseline. */
  acceleration?: {
    multiplier: number;
    windowMinutes: number;
    /** Floor below which acceleration never trips (new agents have no baseline). */
    minSpendCents: number;
  };
};

export type ResolvedBreakerRules = Required<CircuitBreakerRules>;

export const BREAKER_DEFAULTS: ResolvedBreakerRules = {
  enabled: true,
  identical: { count: 5, windowMinutes: 10 },
  velocity: { count: 30, windowMinutes: 5 },
  acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 50_00 },
};

export function resolveBreakerRules(rules: PolicyRules): ResolvedBreakerRules {
  const cb = rules.circuitBreaker;
  return {
    enabled: cb?.enabled ?? BREAKER_DEFAULTS.enabled,
    identical: cb?.identical ?? BREAKER_DEFAULTS.identical,
    velocity: cb?.velocity ?? BREAKER_DEFAULTS.velocity,
    acceleration: cb?.acceleration ?? BREAKER_DEFAULTS.acceleration,
  };
}

export type ReconciliationRules = {
  /** Absolute variance floor; flag only above max(this, percent of expected). */
  toleranceCents?: number;
  tolerancePercent?: number;
};

export type MandateRules = {
  /**
   * Deny purchases that lack a verified payment mandate when they match any
   * of these filters. With no filters set, every purchase needs a mandate.
   */
  require?: { amountCentsAtLeast?: number; categories?: string[] };
};

export type PolicyRules = {
  /** ISO 4217 code all rules are denominated in, e.g. "USD". */
  currency: string;
  maxPerTransactionCents?: number;
  vendors?: { allow?: string[]; deny?: string[] };
  categories?: { allow?: string[]; deny?: string[] };
  budgets?: {
    org?: BudgetLimits;
    /** Default limits applied to every agent. */
    perAgent?: BudgetLimits;
    /** Per-agent overrides, keyed by agent id. */
    agents?: Record<string, BudgetLimits>;
    /** Shared limits across all agents of a team, keyed by team id. */
    teams?: Record<string, BudgetLimits>;
  };
  /** Purchases matching these need a human decision instead of auto-approval. */
  escalation?: { amountCents?: number; categories?: string[] };
  /** Runaway-agent circuit breaker; defaults apply when omitted. */
  circuitBreaker?: CircuitBreakerRules;
  /** Metered-bill reconciliation tolerances; defaults apply when omitted. */
  reconciliation?: ReconciliationRules;
  /** Payment-mandate requirements; mandates are always optional when omitted. */
  mandates?: MandateRules;
};

export type PurchaseIntent = {
  agentId: string;
  vendor: string;
  amountCents: number;
  currency: string;
  category: string;
  justification: string;
  /** True when a payment mandate was presented and verified for this intent. */
  mandateVerified?: boolean;
};

export type StaticDecision =
  | { decision: "approved"; ruleFired: string }
  | { decision: "denied"; ruleFired: string; reason: string }
  | { decision: "pending_approval"; ruleFired: string; reason: string };

/**
 * One rule evaluation in a decision's explanation. `rule` uses the same slug
 * as ruleFired, so the triggered entry always matches the decision.
 */
export type TraceEntry = {
  rule: string;
  result: "pass" | "triggered" | "skipped";
  detail?: string;
};

/** A decision plus the full evaluation trace — explainable approvals too. */
export type EvaluatedDecision = StaticDecision & { trace: TraceEntry[] };

export const norm = (s: string) => s.trim().toLowerCase();

const includesNorm = (list: string[] | undefined, value: string) =>
  (list ?? []).some((item) => norm(item) === norm(value));

type CheckOutcome =
  | { result: "pass"; detail?: string }
  | { result: "skipped"; detail: string }
  | { result: "triggered"; decision: StaticDecision };

const NOT_CONFIGURED: CheckOutcome = {
  result: "skipped",
  detail: "not configured",
};

export function evaluatePolicy(
  rules: PolicyRules,
  intent: PurchaseIntent
): EvaluatedDecision {
  const checks: Array<[rule: string, run: () => CheckOutcome]> = [
    [
      "invalid_amount",
      () =>
        !Number.isInteger(intent.amountCents) || intent.amountCents <= 0
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "invalid_amount",
                reason: `Amount must be a positive integer of cents, got ${intent.amountCents}.`,
              },
            }
          : { result: "pass", detail: `${intent.amountCents}¢ is a valid amount` },
    ],
    [
      "currency_mismatch",
      () =>
        norm(intent.currency) !== norm(rules.currency)
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "currency_mismatch",
                reason: `Policy is denominated in ${rules.currency}; purchase is in ${intent.currency}.`,
              },
            }
          : { result: "pass", detail: `currency ${intent.currency} matches policy` },
    ],
    [
      "vendor_denied",
      () => {
        if (!rules.vendors?.deny?.length) return NOT_CONFIGURED;
        return includesNorm(rules.vendors.deny, intent.vendor)
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "vendor_denied",
                reason: `Vendor "${intent.vendor}" is on the deny list.`,
              },
            }
          : {
              result: "pass",
              detail: `vendor "${intent.vendor}" is not on the deny list (${rules.vendors.deny.length} entries)`,
            };
      },
    ],
    [
      "vendor_not_allowed",
      () => {
        if (!rules.vendors?.allow?.length) return NOT_CONFIGURED;
        return !includesNorm(rules.vendors.allow, intent.vendor)
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "vendor_not_allowed",
                reason: `Vendor "${intent.vendor}" is not on the allow list.`,
              },
            }
          : {
              result: "pass",
              detail: `vendor "${intent.vendor}" is on the allow list`,
            };
      },
    ],
    [
      "category_denied",
      () => {
        if (!rules.categories?.deny?.length) return NOT_CONFIGURED;
        return includesNorm(rules.categories.deny, intent.category)
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "category_denied",
                reason: `Category "${intent.category}" is on the deny list.`,
              },
            }
          : {
              result: "pass",
              detail: `category "${intent.category}" is not on the deny list (${rules.categories.deny.length} entries)`,
            };
      },
    ],
    [
      "category_not_allowed",
      () => {
        if (!rules.categories?.allow?.length) return NOT_CONFIGURED;
        return !includesNorm(rules.categories.allow, intent.category)
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "category_not_allowed",
                reason: `Category "${intent.category}" is not on the allow list.`,
              },
            }
          : {
              result: "pass",
              detail: `category "${intent.category}" is on the allow list`,
            };
      },
    ],
    [
      "over_transaction_cap",
      () => {
        if (rules.maxPerTransactionCents === undefined) return NOT_CONFIGURED;
        return intent.amountCents > rules.maxPerTransactionCents
          ? {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "over_transaction_cap",
                reason: `Amount ${intent.amountCents}¢ exceeds the per-transaction cap of ${rules.maxPerTransactionCents}¢.`,
              },
            }
          : {
              result: "pass",
              detail: `${intent.amountCents}¢ is within the ${rules.maxPerTransactionCents}¢ per-transaction cap`,
            };
      },
    ],
    [
      "mandate_missing",
      () => {
        const require = rules.mandates?.require;
        if (!require) return NOT_CONFIGURED;
        const filters: string[] = [];
        if (require.amountCentsAtLeast !== undefined) {
          filters.push(`amount ≥ ${require.amountCentsAtLeast}¢`);
        }
        if (require.categories?.length) {
          filters.push(`categories [${require.categories.join(", ")}]`);
        }
        const applies =
          filters.length === 0 ||
          (require.amountCentsAtLeast !== undefined &&
            intent.amountCents >= require.amountCentsAtLeast) ||
          includesNorm(require.categories, intent.category);
        if (!applies) {
          return {
            result: "pass",
            detail: `purchase does not match the mandate requirement (${filters.join("; ")})`,
          };
        }
        return intent.mandateVerified
          ? {
              result: "pass",
              detail: "a verified payment mandate covers this purchase",
            }
          : {
              result: "triggered",
              decision: {
                decision: "denied",
                ruleFired: "mandate_missing",
                reason: `Policy requires a verified payment mandate for this purchase${
                  filters.length ? ` (${filters.join("; ")})` : ""
                }, and none was presented.`,
              },
            };
      },
    ],
    [
      "escalation_category",
      () => {
        if (!rules.escalation?.categories?.length) return NOT_CONFIGURED;
        return includesNorm(rules.escalation.categories, intent.category)
          ? {
              result: "triggered",
              decision: {
                decision: "pending_approval",
                ruleFired: "escalation_category",
                reason: `Category "${intent.category}" requires human approval.`,
              },
            }
          : {
              result: "pass",
              detail: `category "${intent.category}" does not require escalation`,
            };
      },
    ],
    [
      "escalation_amount",
      () => {
        if (rules.escalation?.amountCents === undefined) return NOT_CONFIGURED;
        return intent.amountCents >= rules.escalation.amountCents
          ? {
              result: "triggered",
              decision: {
                decision: "pending_approval",
                ruleFired: "escalation_amount",
                reason: `Amount ${intent.amountCents}¢ meets the human-approval threshold of ${rules.escalation.amountCents}¢.`,
              },
            }
          : {
              result: "pass",
              detail: `${intent.amountCents}¢ is below the ${rules.escalation.amountCents}¢ escalation threshold`,
            };
      },
    ],
  ];

  const trace: TraceEntry[] = [];
  let decision: StaticDecision | null = null;
  for (const [rule, run] of checks) {
    if (decision) {
      trace.push({
        rule,
        result: "skipped",
        detail: "skipped: decision already made",
      });
      continue;
    }
    const outcome = run();
    if (outcome.result === "triggered") {
      decision = outcome.decision;
      trace.push({
        rule,
        result: "triggered",
        detail: "reason" in outcome.decision ? outcome.decision.reason : undefined,
      });
    } else {
      trace.push({ rule, result: outcome.result, detail: outcome.detail });
    }
  }

  return {
    ...(decision ?? { decision: "approved", ruleFired: "within_policy" }),
    trace,
  };
}

export function resolveAgentLimits(
  rules: PolicyRules,
  agentId: string
): BudgetLimits | undefined {
  return rules.budgets?.agents?.[agentId] ?? rules.budgets?.perAgent;
}

export function resolveOrgLimits(rules: PolicyRules): BudgetLimits | undefined {
  return rules.budgets?.org;
}

export function resolveTeamLimits(
  rules: PolicyRules,
  teamId: string | null | undefined
): BudgetLimits | undefined {
  if (!teamId) return undefined;
  return rules.budgets?.teams?.[teamId];
}

export const DEFAULT_POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 50_00,
  escalation: { amountCents: 20_00 },
  budgets: { perAgent: { dailyCents: 100_00 }, org: { dailyCents: 500_00 } },
};
