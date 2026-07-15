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
};

export type PurchaseIntent = {
  agentId: string;
  vendor: string;
  amountCents: number;
  currency: string;
  category: string;
  justification: string;
};

export type StaticDecision =
  | { decision: "approved"; ruleFired: string }
  | { decision: "denied"; ruleFired: string; reason: string }
  | { decision: "pending_approval"; ruleFired: string; reason: string };

export const norm = (s: string) => s.trim().toLowerCase();

const includesNorm = (list: string[] | undefined, value: string) =>
  (list ?? []).some((item) => norm(item) === norm(value));

export function evaluatePolicy(
  rules: PolicyRules,
  intent: PurchaseIntent
): StaticDecision {
  if (!Number.isInteger(intent.amountCents) || intent.amountCents <= 0) {
    return {
      decision: "denied",
      ruleFired: "invalid_amount",
      reason: `Amount must be a positive integer of cents, got ${intent.amountCents}.`,
    };
  }

  if (norm(intent.currency) !== norm(rules.currency)) {
    return {
      decision: "denied",
      ruleFired: "currency_mismatch",
      reason: `Policy is denominated in ${rules.currency}; purchase is in ${intent.currency}.`,
    };
  }

  if (includesNorm(rules.vendors?.deny, intent.vendor)) {
    return {
      decision: "denied",
      ruleFired: "vendor_denied",
      reason: `Vendor "${intent.vendor}" is on the deny list.`,
    };
  }

  if (
    rules.vendors?.allow?.length &&
    !includesNorm(rules.vendors.allow, intent.vendor)
  ) {
    return {
      decision: "denied",
      ruleFired: "vendor_not_allowed",
      reason: `Vendor "${intent.vendor}" is not on the allow list.`,
    };
  }

  if (includesNorm(rules.categories?.deny, intent.category)) {
    return {
      decision: "denied",
      ruleFired: "category_denied",
      reason: `Category "${intent.category}" is on the deny list.`,
    };
  }

  if (
    rules.categories?.allow?.length &&
    !includesNorm(rules.categories.allow, intent.category)
  ) {
    return {
      decision: "denied",
      ruleFired: "category_not_allowed",
      reason: `Category "${intent.category}" is not on the allow list.`,
    };
  }

  if (
    rules.maxPerTransactionCents !== undefined &&
    intent.amountCents > rules.maxPerTransactionCents
  ) {
    return {
      decision: "denied",
      ruleFired: "over_transaction_cap",
      reason: `Amount ${intent.amountCents}¢ exceeds the per-transaction cap of ${rules.maxPerTransactionCents}¢.`,
    };
  }

  if (includesNorm(rules.escalation?.categories, intent.category)) {
    return {
      decision: "pending_approval",
      ruleFired: "escalation_category",
      reason: `Category "${intent.category}" requires human approval.`,
    };
  }

  if (
    rules.escalation?.amountCents !== undefined &&
    intent.amountCents >= rules.escalation.amountCents
  ) {
    return {
      decision: "pending_approval",
      ruleFired: "escalation_amount",
      reason: `Amount ${intent.amountCents}¢ meets the human-approval threshold of ${rules.escalation.amountCents}¢.`,
    };
  }

  return { decision: "approved", ruleFired: "within_policy" };
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
