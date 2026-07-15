// Circuit-breaker detection: deterministic pattern checks over an agent's
// recent request_purchase traffic. Pure functions only — the request history
// and freeze state live in OrgCoordinator, which calls evaluateBreaker on
// every purchase request.
//
// All requests count, including denied ones: a loop of denials is still a
// runaway loop, and the point is to catch the pattern before it compounds.

import { norm, type ResolvedBreakerRules } from "./policy";

export type RequestSample = {
  vendor: string;
  amountCents: number;
  category: string;
  atIso: string;
};

export type BreakerSignal = "identical_loop" | "velocity" | "spend_acceleration";

export type BreakerVerdict =
  | { tripped: false }
  | { tripped: true; signal: BreakerSignal; reason: string };

const MINUTE_MS = 60_000;
export const HISTORY_WINDOW_MS = 24 * 60 * MINUTE_MS;

const sameRequest = (a: RequestSample, b: RequestSample) =>
  norm(a.vendor) === norm(b.vendor) &&
  a.amountCents === b.amountCents &&
  norm(a.category) === norm(b.category);

/**
 * Evaluate the breaker for one incoming request.
 * `history` is the agent's prior requests within the trailing 24h, excluding
 * `current`. Timestamps are ISO 8601 UTC.
 */
export function evaluateBreaker(
  rules: ResolvedBreakerRules,
  history: RequestSample[],
  current: RequestSample
): BreakerVerdict {
  if (!rules.enabled) return { tripped: false };

  const nowMs = Date.parse(current.atIso);
  const inWindow = (sample: RequestSample, windowMinutes: number) =>
    Date.parse(sample.atIso) > nowMs - windowMinutes * MINUTE_MS;

  const identicalCount =
    history.filter(
      (s) => sameRequest(s, current) && inWindow(s, rules.identical.windowMinutes)
    ).length + 1;
  if (identicalCount >= rules.identical.count) {
    return {
      tripped: true,
      signal: "identical_loop",
      reason:
        `The same purchase ("${current.vendor}", ${current.amountCents}¢, ` +
        `"${current.category}") was requested ${identicalCount} times in the last ` +
        `${rules.identical.windowMinutes} minutes — this looks like a runaway loop.`,
    };
  }

  const velocityCount =
    history.filter((s) => inWindow(s, rules.velocity.windowMinutes)).length + 1;
  if (velocityCount >= rules.velocity.count) {
    return {
      tripped: true,
      signal: "velocity",
      reason:
        `${velocityCount} purchase requests in the last ` +
        `${rules.velocity.windowMinutes} minutes reached the velocity limit of ` +
        `${rules.velocity.count} — this agent is requesting far faster than any deliberate buyer.`,
    };
  }

  // Spend acceleration: requested spend in the current window vs the mean of
  // the same-length windows over the rest of the trailing 24h. Acceleration
  // needs a baseline to accelerate past — an agent with no history outside
  // the window never trips this signal (identical/velocity and hard budgets
  // cover brand-new runaways), so a legitimate first big purchase can't
  // freeze the agent.
  const accel = rules.acceleration;
  const windowMs = accel.windowMinutes * MINUTE_MS;
  const windowSpend =
    history
      .filter((s) => inWindow(s, accel.windowMinutes))
      .reduce((sum, s) => sum + s.amountCents, 0) + current.amountCents;
  const priorSpend = history
    .filter((s) => !inWindow(s, accel.windowMinutes))
    .reduce((sum, s) => sum + s.amountCents, 0);
  const priorWindows = Math.max(1, Math.floor(HISTORY_WINDOW_MS / windowMs) - 1);
  const baseline = priorSpend / priorWindows;
  if (
    baseline > 0 &&
    windowSpend > accel.minSpendCents &&
    windowSpend > accel.multiplier * baseline
  ) {
    return {
      tripped: true,
      signal: "spend_acceleration",
      reason:
        `Requested spend of ${windowSpend}¢ in the last ${accel.windowMinutes} minutes ` +
        `is more than ${accel.multiplier}× this agent's trailing baseline of ` +
        `${Math.round(baseline)}¢ per ${accel.windowMinutes}-minute window — ` +
        `spending is accelerating far past normal.`,
    };
  }

  return { tripped: false };
}
