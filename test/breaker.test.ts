import { describe, expect, it } from "vitest";
import {
  evaluateBreaker,
  type RequestSample,
} from "../src/breaker";
import { BREAKER_DEFAULTS, type ResolvedBreakerRules } from "../src/policy";

const T0 = Date.parse("2026-07-14T12:00:00.000Z");
const at = (minutesAgo: number) =>
  new Date(T0 - minutesAgo * 60_000).toISOString();

const sample = (over: Partial<RequestSample> = {}): RequestSample => ({
  vendor: "OpenAI",
  amountCents: 500,
  category: "api",
  atIso: at(0),
  ...over,
});

// Rules where each signal is easy to isolate: the shared rules keep the
// acceleration floor high so loop/velocity tests can't trip it by accident.
const rules: ResolvedBreakerRules = {
  enabled: true,
  identical: { count: 3, windowMinutes: 10 },
  velocity: { count: 6, windowMinutes: 5 },
  acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 1_000_00 },
};
const accelRules: ResolvedBreakerRules = {
  ...rules,
  acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 10_00 },
};

describe("evaluateBreaker: identical_loop", () => {
  it("trips when the same request repeats `count` times within the window", () => {
    const history = [sample({ atIso: at(9) }), sample({ atIso: at(1) })];
    const verdict = evaluateBreaker(rules, history, sample());
    expect(verdict).toMatchObject({ tripped: true, signal: "identical_loop" });
  });

  it("does not trip one repetition short of the threshold", () => {
    const history = [sample({ atIso: at(1) })];
    expect(evaluateBreaker(rules, history, sample()).tripped).toBe(false);
  });

  it("ignores identical requests older than the window", () => {
    const history = [sample({ atIso: at(11) }), sample({ atIso: at(15) })];
    expect(evaluateBreaker(rules, history, sample()).tripped).toBe(false);
  });

  it("matches vendor and category case- and whitespace-insensitively", () => {
    const history = [
      sample({ vendor: "openai ", category: "API", atIso: at(2) }),
      sample({ vendor: " OPENAI", category: "api", atIso: at(1) }),
    ];
    const verdict = evaluateBreaker(rules, history, sample());
    expect(verdict).toMatchObject({ tripped: true, signal: "identical_loop" });
  });

  it("does not count requests with a different amount as identical", () => {
    const history = [
      sample({ amountCents: 501, atIso: at(2) }),
      sample({ amountCents: 502, atIso: at(1) }),
    ];
    expect(evaluateBreaker(rules, history, sample()).tripped).toBe(false);
  });
});

describe("evaluateBreaker: velocity", () => {
  // Distinct vendors so identical_loop stays quiet.
  const burst = (n: number, minutesAgo: number) =>
    Array.from({ length: n }, (_, i) =>
      sample({ vendor: `vendor-${i}`, amountCents: 10 + i, atIso: at(minutesAgo) })
    );

  it("trips when total requests in the window reach the limit", () => {
    const verdict = evaluateBreaker(rules, burst(5, 1), sample({ vendor: "x", amountCents: 7 }));
    expect(verdict).toMatchObject({ tripped: true, signal: "velocity" });
  });

  it("does not trip below the limit or outside the window", () => {
    expect(
      evaluateBreaker(rules, burst(4, 1), sample({ vendor: "x", amountCents: 7 })).tripped
    ).toBe(false);
    expect(
      evaluateBreaker(rules, burst(5, 6), sample({ vendor: "x", amountCents: 7 })).tripped
    ).toBe(false);
  });
});

describe("evaluateBreaker: spend_acceleration", () => {
  it("never trips an agent with no baseline, however large the request", () => {
    // A legitimate first big purchase must not freeze a brand-new agent;
    // identical/velocity signals and hard budgets cover new runaways.
    const verdict = evaluateBreaker(accelRules, [], sample({ amountCents: 500_00 }));
    expect(verdict.tripped).toBe(false);
  });

  it("never trips at or below the minSpendCents floor", () => {
    // Tiny baseline (100¢ over 23 prior windows ≈ 4¢/window): the multiplier
    // is exceeded either way, so the floor is what decides.
    const history = [sample({ vendor: "old", amountCents: 1_00, atIso: at(61) })];
    expect(
      evaluateBreaker(accelRules, history, sample({ amountCents: 9_00 })).tripped
    ).toBe(false);
    const verdict = evaluateBreaker(accelRules, history, sample({ amountCents: 10_01 }));
    expect(verdict).toMatchObject({ tripped: true, signal: "spend_acceleration" });
  });

  it("does not trip when spend stays within multiplier × baseline", () => {
    // 23h of steady history: 23 windows' worth of prior spend.
    // priorSpend = 23_000¢ over 23 prior windows → baseline 1000¢/window.
    const history = Array.from({ length: 23 }, (_, i) =>
      sample({ vendor: `v${i}`, amountCents: 10_00, atIso: at(61 + i * 60) })
    );
    // 3900¢ in the current window < 4 × 1000¢ baseline.
    const current = sample({ vendor: "spender", amountCents: 39_00 });
    expect(evaluateBreaker(accelRules, history, current).tripped).toBe(false);
  });

  it("trips when window spend exceeds multiplier × baseline and the floor", () => {
    const history = Array.from({ length: 23 }, (_, i) =>
      sample({ vendor: `v${i}`, amountCents: 10_00, atIso: at(61 + i * 60) })
    );
    // 4100¢ > 4 × 1000¢ baseline and > 1000¢ floor.
    const current = sample({ vendor: "spender", amountCents: 41_00 });
    const verdict = evaluateBreaker(accelRules, history, current);
    expect(verdict).toMatchObject({ tripped: true, signal: "spend_acceleration" });
  });
});

describe("evaluateBreaker: enabled flag and defaults", () => {
  it("never trips when disabled", () => {
    const disabled = { ...rules, enabled: false };
    const history = Array.from({ length: 50 }, () => sample({ atIso: at(1) }));
    expect(evaluateBreaker(disabled, history, sample()).tripped).toBe(false);
  });

  it("default rules trip the canonical runaway loop (5 identical in 10 min)", () => {
    const history = Array.from({ length: 4 }, (_, i) =>
      sample({ atIso: at(i + 1) })
    );
    const verdict = evaluateBreaker(BREAKER_DEFAULTS, history, sample());
    expect(verdict).toMatchObject({ tripped: true, signal: "identical_loop" });
  });

  it("reasons are plain language mentioning the offending pattern", () => {
    const history = [sample({ atIso: at(9) }), sample({ atIso: at(1) })];
    const verdict = evaluateBreaker(rules, history, sample());
    if (!verdict.tripped) throw new Error("expected trip");
    expect(verdict.reason).toContain("OpenAI");
    expect(verdict.reason).toContain("runaway loop");
  });
});
