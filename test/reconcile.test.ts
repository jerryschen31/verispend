import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../src/ledger";
import type { PolicyRules } from "../src/policy";
import { classifyVariance, RECON_DEFAULTS } from "../src/reconcile";
import { McpSession, provisionOrg } from "./helpers";

describe("classifyVariance", () => {
  const tolerance = RECON_DEFAULTS; // 100¢ absolute, 2%

  it("passes exact matches and variances within tolerance", () => {
    expect(
      classifyVariance({ expectedCents: 40_00, billedCents: 40_00, tolerance })
    ).toEqual({ status: "ok", varianceCents: 0 });
    // 2% of 100_00 = 200¢: a 200¢ overage is exactly at tolerance.
    expect(
      classifyVariance({ expectedCents: 100_00, billedCents: 102_00, tolerance })
    ).toEqual({ status: "ok", varianceCents: 2_00 });
  });

  it("uses the absolute floor when 2% would be tighter", () => {
    // 2% of 10_00 is 20¢, but the 100¢ floor allows up to $1 variance.
    expect(
      classifyVariance({ expectedCents: 10_00, billedCents: 10_99, tolerance })
    ).toMatchObject({ status: "ok" });
    expect(
      classifyVariance({ expectedCents: 10_00, billedCents: 11_01, tolerance })
    ).toMatchObject({ status: "overbilled", varianceCents: 1_01 });
  });

  it("flags overbilled and underbilled past tolerance", () => {
    expect(
      classifyVariance({ expectedCents: 100_00, billedCents: 102_01, tolerance })
    ).toMatchObject({ status: "overbilled" });
    expect(
      classifyVariance({ expectedCents: 100_00, billedCents: 97_99, tolerance })
    ).toMatchObject({ status: "underbilled" });
  });

  it("flags bills with no usage data at all", () => {
    expect(
      classifyVariance({ expectedCents: 0, billedCents: 5_00, tolerance })
    ).toEqual({ status: "no_usage_data", varianceCents: 5_00 });
  });
});

describe("record_usage and bill reconciliation end to end", () => {
  const POLICY: PolicyRules = {
    currency: "USD",
    budgets: { perAgent: { dailyCents: 100_00 } },
  };

  let orgId: string;
  let session: McpSession;

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Metered Corp",
      agentId: "metered-agent",
      policy: POLICY,
    });
    orgId = org.orgId;
    session = new McpSession(org.apiKey);
    await session.initialize();
  });

  const ingest = (body: Record<string, unknown>) =>
    SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/bills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "test-admin-key" },
      body: JSON.stringify(body),
    });

  it("records usage, counts it against budgets, and warns on overrun", async () => {
    const first = await session.call("record_usage", {
      vendor: "OpenAI",
      metric: "input_tokens",
      units: 1_200_000,
      expected_cost_cents: 30_00,
      note: "batch summarization",
    });
    expect(first.usage_id).toMatch(/^ur_/);
    expect(first.agent_daily_used_cents).toBe(30_00);
    expect(first.warning).toBeUndefined();

    const budget = await session.call("get_budget_status", {});
    expect(budget.agent.daily_used_cents).toBe(30_00);

    // Usage can't be blocked, but blowing the budget comes back as a warning.
    const second = await session.call("record_usage", {
      vendor: "openai", // different casing on purpose
      metric: "input_tokens",
      units: 3_000_000,
      expected_cost_cents: 75_00,
      note: "runaway batch",
    });
    expect(second.agent_daily_used_cents).toBe(105_00);
    expect(second.warning).toContain("agent daily budget exceeded");

    const usageEvents = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ledger_events WHERE org_id = ? AND event_type = 'usage_recorded'"
    )
      .bind(orgId)
      .first<{ n: number }>();
    expect(usageEvents!.n).toBe(2);
  });

  it("reconciles a matching bill as ok, case-insensitively on vendor", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await ingest({
      vendor: "OPENAI",
      period_start: today,
      period_end: today,
      amount_cents: 105_00,
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.expected_cents).toBe(105_00);
    expect(body.recon_status).toBe("ok");
  });

  it("flags an inflated bill as overbilled and records it on the ledger", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await ingest({
      vendor: "OpenAI",
      period_start: today,
      period_end: today,
      amount_cents: 150_00,
      memo: "wrong pricing tier",
    });
    const body = await res.json<any>();
    expect(body.recon_status).toBe("overbilled");
    expect(body.variance_cents).toBe(45_00);

    const events = await env.DB.prepare(
      "SELECT event_type FROM ledger_events WHERE org_id = ? AND request_id = ? ORDER BY seq"
    )
      .bind(orgId, body.bill_id)
      .all<{ event_type: string }>();
    expect(events.results.map((e) => e.event_type)).toEqual([
      "bill_ingested",
      "bill_reconciled",
    ]);
    expect(await verifyLedgerChain(env.DB, orgId)).toMatchObject({ ok: true });
  });

  it("flags a bill from a vendor with no recorded usage", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await ingest({
      vendor: "MysteryCloud",
      period_start: today,
      period_end: today,
      amount_cents: 20_00,
    });
    expect((await res.json<any>()).recon_status).toBe("no_usage_data");
  });

  it("only sums usage inside the bill period", async () => {
    // A bill for a window that predates all recorded usage sees none of it.
    const res = await ingest({
      vendor: "OpenAI",
      period_start: "2026-01-01",
      period_end: "2026-01-31",
      amount_cents: 10_00,
    });
    const body = await res.json<any>();
    expect(body.expected_cents).toBe(0);
    expect(body.recon_status).toBe("no_usage_data");
  });

  it("rejects malformed bills and bad admin keys", async () => {
    const bad = await ingest({
      vendor: "OpenAI",
      period_start: "01/01/2026",
      period_end: "2026-01-31",
      amount_cents: 10_00,
    });
    expect(bad.status).toBe(400);

    const unauthorized = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/bills`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "wrong" },
        body: JSON.stringify({}),
      }
    );
    expect(unauthorized.status).toBe(401);
  });
});
