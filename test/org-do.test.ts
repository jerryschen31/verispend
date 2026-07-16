import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../src/ledger";

const NOW = "2026-07-11T12:00:00.000Z";

describe("OrgCoordinator budgets", () => {
  it("enforces agent daily limits atomically under concurrency", async () => {
    const stub = env.ORG.getByName("org-concurrency");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        stub.reserve({
          agentId: "agent-1",
          amountCents: 30_00,
          agentLimits: { dailyCents: 100_00 },
          nowIso: NOW,
        })
      )
    );
    const approved = results.filter((r) => r.ok);
    expect(approved).toHaveLength(3); // 3 × $30 = $90 fits in $100; a 4th would not

    const usage = await stub.usage({ agentId: "agent-1", nowIso: NOW });
    expect(usage.agentDailyCents).toBe(90_00);
    expect(usage.orgDailyCents).toBe(90_00);
  });

  it("reports which limit was exceeded", async () => {
    const stub = env.ORG.getByName("org-limits");
    await stub.reserve({
      agentId: "a",
      amountCents: 40_00,
      orgLimits: { monthlyCents: 50_00 },
      nowIso: NOW,
    });
    const result = await stub.reserve({
      agentId: "b",
      amountCents: 20_00,
      orgLimits: { monthlyCents: 50_00 },
      nowIso: NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      exceeded: "org_monthly",
      scope: "org",
      period: "monthly",
      limitCents: 50_00,
      usedCents: 40_00,
    });
  });

  it("enforces a shared team budget across agents, atomically", async () => {
    const stub = env.ORG.getByName("org-team-race");
    const agents = ["a", "b", "c"];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        stub.reserve({
          agentId: agents[i % 3],
          amountCents: 10_00,
          teamId: "t1",
          teamLimits: { dailyCents: 50_00 },
          nowIso: NOW,
        })
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5); // 5 × $10 = the $50 cap

    const usage = await stub.usage({ agentId: "a", teamId: "t1", nowIso: NOW });
    expect(usage.teamDailyCents).toBe(50_00);
  });

  it("reports team scope details on a team-budget denial", async () => {
    const stub = env.ORG.getByName("org-team-detail");
    await stub.reserve({
      agentId: "a",
      amountCents: 40_00,
      teamId: "t1",
      teamLimits: { dailyCents: 50_00 },
      agentLimits: { dailyCents: 100_00 },
      nowIso: NOW,
    });
    const denied = await stub.reserve({
      agentId: "b",
      amountCents: 15_00,
      teamId: "t1",
      teamLimits: { dailyCents: 50_00 },
      agentLimits: { dailyCents: 100_00 },
      nowIso: NOW,
    });
    expect(denied).toMatchObject({
      ok: false,
      exceeded: "team_daily",
      scope: "team",
      scopeId: "t1",
      period: "daily",
      limitCents: 50_00,
      usedCents: 40_00,
    });
    // The passing agent check comes along for explainability.
    expect(denied.checks).toContainEqual({
      scope: "agent",
      scopeId: "b",
      period: "daily",
      limitCents: 100_00,
      usedCents: 0,
    });
  });

  it("trips the smaller agent cap before the team cap", async () => {
    const stub = env.ORG.getByName("org-team-order");
    const denied = await stub.reserve({
      agentId: "a",
      amountCents: 20_00,
      agentLimits: { dailyCents: 10_00 },
      teamId: "t1",
      teamLimits: { dailyCents: 100_00 },
      nowIso: NOW,
    });
    expect(denied).toMatchObject({ ok: false, exceeded: "agent_daily" });
  });

  it("adjust with a teamId corrects team counters; without leaves them", async () => {
    const stub = env.ORG.getByName("org-team-adjust");
    await stub.reserve({
      agentId: "a",
      amountCents: 30_00,
      teamId: "t1",
      nowIso: NOW,
    });
    await stub.adjust({ agentId: "a", deltaCents: -8_00, teamId: "t1", nowIso: NOW });
    let usage = await stub.usage({ agentId: "a", teamId: "t1", nowIso: NOW });
    expect(usage.teamDailyCents).toBe(22_00);

    // Legacy call shape (no teamId) still works and leaves team counters alone.
    await stub.adjust({ agentId: "a", deltaCents: -2_00, nowIso: NOW });
    usage = await stub.usage({ agentId: "a", teamId: "t1", nowIso: NOW });
    expect(usage.teamDailyCents).toBe(22_00);
    expect(usage.agentDailyCents).toBe(20_00);
  });

  it("resets across day and month boundaries", async () => {
    const stub = env.ORG.getByName("org-periods");
    const limits = { dailyCents: 50_00 };
    expect(
      (
        await stub.reserve({
          agentId: "a",
          amountCents: 50_00,
          agentLimits: limits,
          nowIso: "2026-07-11T23:00:00.000Z",
        })
      ).ok
    ).toBe(true);
    // Same day: exhausted.
    expect(
      (
        await stub.reserve({
          agentId: "a",
          amountCents: 1_00,
          agentLimits: limits,
          nowIso: "2026-07-11T23:30:00.000Z",
        })
      ).ok
    ).toBe(false);
    // Next day: fresh budget.
    expect(
      (
        await stub.reserve({
          agentId: "a",
          amountCents: 50_00,
          agentLimits: limits,
          nowIso: "2026-07-12T00:30:00.000Z",
        })
      ).ok
    ).toBe(true);
  });

  it("adjust corrects counters without limit checks", async () => {
    const stub = env.ORG.getByName("org-adjust");
    await stub.reserve({ agentId: "a", amountCents: 30_00, nowIso: NOW });
    // Final charge came in $8 under the approved amount.
    await stub.adjust({ agentId: "a", deltaCents: -8_00, nowIso: NOW });
    const usage = await stub.usage({ agentId: "a", nowIso: NOW });
    expect(usage.agentDailyCents).toBe(22_00);
  });
});

describe("OrgCoordinator circuit breaker", () => {
  const breakerRules = {
    enabled: true,
    identical: { count: 3, windowMinutes: 10 },
    velocity: { count: 20, windowMinutes: 5 },
    acceleration: { multiplier: 4, windowMinutes: 60, minSpendCents: 1_000_00 },
  };
  const atMinute = (m: number) =>
    new Date(Date.parse(NOW) + m * 60_000).toISOString();
  const check = (
    stub: ReturnType<typeof env.ORG.getByName>,
    agentId: string,
    nowIso: string,
    over: Partial<{ vendor: string; amountCents: number; category: string }> = {}
  ) =>
    stub.recordAndCheck({
      agentId,
      vendor: "OpenAI",
      amountCents: 5_00,
      category: "api",
      breakerRules,
      nowIso,
      ...over,
    });

  it("trips on an identical-request loop and persists the freeze", async () => {
    const stub = env.ORG.getByName("org-breaker-loop");
    expect((await check(stub, "loop", atMinute(0))).status).toBe("ok");
    expect((await check(stub, "loop", atMinute(1))).status).toBe("ok");
    const third = await check(stub, "loop", atMinute(2));
    expect(third).toMatchObject({ status: "tripped", signal: "identical_loop" });

    // Now frozen: further requests short-circuit without re-evaluating.
    const fourth = await check(stub, "loop", atMinute(3));
    expect(fourth).toMatchObject({ status: "frozen" });
    expect(await stub.isFrozen({ agentId: "loop" })).toMatchObject({ frozen: true });

    // Other agents in the org are unaffected.
    expect((await check(stub, "other-agent", atMinute(3))).status).toBe("ok");

    const frozen = await stub.frozenAgents();
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ agent_id: "loop", signal: "identical_loop" });
  });

  it("unfreeze restores the agent (and reports missing freezes)", async () => {
    const stub = env.ORG.getByName("org-breaker-unfreeze");
    await check(stub, "a", atMinute(0));
    await check(stub, "a", atMinute(1));
    expect((await check(stub, "a", atMinute(2))).status).toBe("tripped");

    expect(await stub.unfreeze({ agentId: "a" })).toEqual({ ok: true });
    expect(await stub.unfreeze({ agentId: "a" })).toEqual({ ok: false });
    expect(await stub.isFrozen({ agentId: "a" })).toEqual({ frozen: false });

    // History persists, so the very next identical request re-trips.
    expect((await check(stub, "a", atMinute(3))).status).toBe("tripped");
  });

  it("ignores identical requests outside the detection window", async () => {
    const stub = env.ORG.getByName("org-breaker-window");
    await check(stub, "a", atMinute(0));
    await check(stub, "a", atMinute(1));
    // 11+ minutes later: the earlier pair is outside the 10-minute window.
    expect((await check(stub, "a", atMinute(12))).status).toBe("ok");

    // 25h later everything is pruned; two fresh identical requests don't trip.
    const dayLater = atMinute(25 * 60);
    expect((await check(stub, "a", dayLater)).status).toBe("ok");
    expect(
      (await check(stub, "a", atMinute(25 * 60 + 1))).status
    ).toBe("ok");
  });

  it("trips on velocity across distinct requests", async () => {
    const stub = env.ORG.getByName("org-breaker-velocity");
    for (let i = 0; i < 19; i++) {
      const result = await check(stub, "fast", atMinute(1), {
        vendor: `vendor-${i}`,
        amountCents: 10 + i,
      });
      expect(result.status).toBe("ok");
    }
    const twentieth = await check(stub, "fast", atMinute(2), {
      vendor: "vendor-final",
      amountCents: 7,
    });
    expect(twentieth).toMatchObject({ status: "tripped", signal: "velocity" });
  });
});

describe("OrgCoordinator ledger appends", () => {
  it("keeps the hash chain intact under concurrent appends", async () => {
    const orgId = "org-ledger";
    const stub = env.ORG.getByName(orgId);
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        stub.appendEvent({
          orgId,
          requestId: `req-${i}`,
          eventType: "purchase_requested",
          payload: { i },
        })
      )
    );

    const verification = await verifyLedgerChain(env.DB, orgId);
    expect(verification).toEqual({ ok: true, count: 15 });
  });

  it("detects tampering with a ledger row", async () => {
    const orgId = "org-tamper";
    const stub = env.ORG.getByName(orgId);
    for (let i = 0; i < 3; i++) {
      await stub.appendEvent({
        orgId,
        requestId: `req-${i}`,
        eventType: "auto_decision",
        payload: { amountCents: 100 + i },
      });
    }

    await env.DB.prepare(
      "UPDATE ledger_events SET payload_json = ? WHERE org_id = ? AND request_id = ?"
    )
      .bind(JSON.stringify({ amountCents: 1 }), orgId, "req-1")
      .run();

    const verification = await verifyLedgerChain(env.DB, orgId);
    expect(verification.ok).toBe(false);
  });
});
