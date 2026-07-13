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
    expect(result).toEqual({
      ok: false,
      exceeded: "org_monthly",
      limitCents: 50_00,
      usedCents: 40_00,
    });
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
