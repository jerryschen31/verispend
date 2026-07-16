import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyMatch, normalizeSettlement } from "../src/settlements";
import { RECON_DEFAULTS } from "../src/reconcile";
import { verifyLedgerChain } from "../src/ledger";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 500_00,
  budgets: { perAgent: { dailyCents: 2000_00 } },
};

const ingest = (orgId: string, rail: string, payload: Record<string, unknown>) =>
  SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/settlements`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify({ rail, ...payload }),
  });

type IngestResult = {
  results: Array<{
    settlement_id: string;
    match_status: string;
    match_method: string;
    matched_request_id: string | null;
    variance_cents: number;
    duplicate: boolean;
    error?: string;
  }>;
};

describe("rail adapters", () => {
  it("normalizes each rail's payload shape", () => {
    const card = normalizeSettlement("card", {
      auth_code: "AUTH123",
      merchant: "Figma",
      amount_cents: 15_00,
      currency: "USD",
      posted_at: "2026-07-15T10:00:00Z",
    });
    expect(card).toMatchObject({
      ok: true,
      input: { rail: "card", settlementRef: "AUTH123", vendor: "Figma", amountCents: 15_00 },
    });

    const chain = normalizeSettlement("stablecoin", {
      tx_hash: "0xabc",
      payee: "DataMart",
      amount_cents: 30_00,
      currency: "USD",
      block_time: "2026-07-15T10:05:00Z",
    });
    expect(chain).toMatchObject({
      ok: true,
      input: { rail: "stablecoin", settlementRef: "0xabc", vendor: "DataMart" },
    });

    const checkout = normalizeSettlement("checkout", {
      order_id: "ord_9",
      merchant: "OfficeMax",
      total_cents: 8_50,
      completed_at: "2026-07-15T11:00:00Z",
    });
    expect(checkout).toMatchObject({
      ok: true,
      input: { settlementRef: "ord_9", amountCents: 8_50, currency: "USD" },
    });
  });

  it("normalizes a Stripe charge.succeeded-shaped event, converting unix time", () => {
    const result = normalizeSettlement("stripe_event", {
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_3abc",
          amount: 25_00,
          currency: "usd",
          calculated_statement_descriptor: "FIGMA",
          created: 1783600000,
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      input: {
        settlementRef: "ch_3abc",
        vendor: "FIGMA",
        amountCents: 25_00,
        currency: "USD",
        occurredAt: new Date(1783600000 * 1000).toISOString(),
      },
    });
  });

  it("rejects malformed payloads and unknown rails with a reason", () => {
    expect(normalizeSettlement("card", { merchant: "X" })).toMatchObject({
      ok: false,
    });
    expect(
      normalizeSettlement("card", {
        auth_code: "A",
        merchant: "X",
        amount_cents: -5,
        posted_at: "2026-07-15T10:00:00Z",
      })
    ).toMatchObject({ ok: false });
    expect(
      normalizeSettlement("card", {
        auth_code: "A",
        merchant: "X",
        amount_cents: 10,
        posted_at: "not a date",
      })
    ).toMatchObject({ ok: false });
    expect(normalizeSettlement("telepathy", {})).toMatchObject({ ok: false });
  });
});

describe("classifyMatch tolerance edges", () => {
  const tolerance = RECON_DEFAULTS; // 100¢ floor, 2%

  it("matches within the absolute floor and flags just past it", () => {
    expect(
      classifyMatch({ settledCents: 11_00, referenceCents: 10_00, tolerance })
    ).toMatchObject({ status: "matched", varianceCents: 1_00 });
    expect(
      classifyMatch({ settledCents: 11_01, referenceCents: 10_00, tolerance })
    ).toMatchObject({ status: "amount_mismatch", varianceCents: 1_01 });
  });

  it("uses the percent tolerance when it exceeds the floor", () => {
    // 2% of $200 = $4 > $1 floor.
    expect(
      classifyMatch({ settledCents: 204_00, referenceCents: 200_00, tolerance })
    ).toMatchObject({ status: "matched" });
    expect(
      classifyMatch({ settledCents: 204_01, referenceCents: 200_00, tolerance })
    ).toMatchObject({ status: "amount_mismatch" });
  });
});

describe("settlement ingestion and cross-rail matching end to end", () => {
  let orgId: string;
  let agent: McpSession;

  const buy = async (vendor: string, amountCents: number) => {
    const res = await agent.call("request_purchase", {
      vendor,
      amount_cents: amountCents,
      currency: "USD",
      category: "software",
      justification: "settlement testing",
    });
    expect(res.status).toBe("approved");
    return res as { request_id: string; approval_ref: string };
  };

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Settlement Org",
      agentId: "stl-agent",
      approverEmail: "admin@settle.test",
      policy: POLICY,
    });
    orgId = org.orgId;
    agent = new McpSession(org.apiKey);
    expect(await agent.initialize()).toBe(200);
  });

  it("matches by the agent-reported settlement_ref (tier 1)", async () => {
    const purchase = await buy("Figma", 15_00);
    const outcome = await agent.call("record_outcome", {
      request_id: purchase.request_id,
      final_amount_cents: 15_00,
      rail: "card",
      settlement_ref: "AUTH-T1",
    });
    expect(outcome.status).toBe("completed");

    const res = await ingest(orgId, "card", {
      auth_code: "AUTH-T1",
      merchant: "Figma",
      amount_cents: 15_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json<IngestResult>();
    expect(body.results[0]).toMatchObject({
      match_status: "matched",
      match_method: "settlement_ref",
      matched_request_id: purchase.request_id,
      variance_cents: 0,
      duplicate: false,
    });
  });

  it("matches when the rail echoes our approval_ref back (tier 2)", async () => {
    const purchase = await buy("Linear", 20_00);
    const res = await ingest(orgId, "checkout", {
      order_id: purchase.approval_ref,
      merchant: "Linear",
      total_cents: 20_00,
      completed_at: new Date().toISOString(),
    });
    const body = await res.json<IngestResult>();
    expect(body.results[0]).toMatchObject({
      match_status: "matched",
      match_method: "approval_ref",
      matched_request_id: purchase.request_id,
    });
  });

  it("matches heuristically on vendor + amount + time (tier 3), oldest first", async () => {
    const older = await buy("DataMart", 30_00);
    const newer = await buy("DataMart", 30_00);

    const first = await ingest(orgId, "stablecoin", {
      tx_hash: "0xheur1",
      payee: "DataMart",
      amount_cents: 30_00,
      currency: "USD",
      block_time: new Date().toISOString(),
    });
    expect((await first.json<IngestResult>()).results[0]).toMatchObject({
      match_status: "matched",
      match_method: "heuristic",
      matched_request_id: older.request_id,
    });

    // The second identical charge pairs with the remaining purchase.
    const second = await ingest(orgId, "stablecoin", {
      tx_hash: "0xheur2",
      payee: "DataMart",
      amount_cents: 30_00,
      currency: "USD",
      block_time: new Date().toISOString(),
    });
    expect((await second.json<IngestResult>()).results[0]).toMatchObject({
      match_status: "matched",
      matched_request_id: newer.request_id,
    });
  });

  it("flags an over-charged settlement as amount_mismatch and alerts", async () => {
    const purchase = await buy("Notion", 40_00);
    await agent.call("record_outcome", {
      request_id: purchase.request_id,
      final_amount_cents: 40_00,
      rail: "card",
      settlement_ref: "AUTH-OVER",
    });
    const res = await ingest(orgId, "card", {
      auth_code: "AUTH-OVER",
      merchant: "Notion",
      amount_cents: 55_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    });
    const body = await res.json<IngestResult>();
    expect(body.results[0]).toMatchObject({
      match_status: "amount_mismatch",
      matched_request_id: purchase.request_id,
      variance_cents: 15_00,
    });
  });

  it("flags a charge no agent requested as unauthorized, on the ledger too", async () => {
    const res = await ingest(orgId, "card", {
      auth_code: "AUTH-ROGUE",
      merchant: "Mystery Vendor",
      amount_cents: 99_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    });
    const body = await res.json<IngestResult>();
    const rogue = body.results[0];
    expect(rogue).toMatchObject({
      match_status: "unauthorized",
      match_method: "none",
      matched_request_id: null,
    });

    const event = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND request_id = ? AND event_type = 'unauthorized_charge'"
    )
      .bind(orgId, rogue.settlement_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      vendor: "Mystery Vendor",
      amountCents: 99_00,
    });
  });

  it("is idempotent: re-ingesting the same record adds no rows or events", async () => {
    const payload = {
      auth_code: "AUTH-DUP",
      merchant: "Mystery Vendor",
      amount_cents: 12_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    };
    const first = await (await ingest(orgId, "card", payload)).json<IngestResult>();
    const eventsBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ledger_events WHERE org_id = ?"
    )
      .bind(orgId)
      .first<{ n: number }>();

    const second = await (await ingest(orgId, "card", payload)).json<IngestResult>();
    expect(second.results[0]).toMatchObject({
      settlement_id: first.results[0].settlement_id,
      duplicate: true,
    });

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM settlements WHERE org_id = ? AND settlement_ref = 'AUTH-DUP'"
    )
      .bind(orgId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const eventsAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ledger_events WHERE org_id = ?"
    )
      .bind(orgId)
      .first<{ n: number }>();
    expect(eventsAfter?.n).toBe(eventsBefore?.n);
  });

  it("re-matches a settlement that arrived before the agent reported (rematch)", async () => {
    // Settlement lands first: nothing to match, flagged unauthorized.
    const early = await (
      await ingest(orgId, "card", {
        auth_code: "AUTH-EARLY",
        merchant: "LateVendor",
        amount_cents: 25_00,
        currency: "USD",
        posted_at: new Date().toISOString(),
      })
    ).json<IngestResult>();
    expect(early.results[0].match_status).toBe("unauthorized");

    const purchase = await buy("LateVendor", 25_00);
    const outcome = await agent.call("record_outcome", {
      request_id: purchase.request_id,
      final_amount_cents: 25_00,
      rail: "card",
      settlement_ref: "AUTH-EARLY",
    });
    expect(outcome.settlement_match).toMatchObject({
      settlement_id: early.results[0].settlement_id,
      match_status: "matched",
    });

    const row = await env.DB.prepare(
      "SELECT match_status, match_method, matched_request_id FROM settlements WHERE org_id = ? AND id = ?"
    )
      .bind(orgId, early.results[0].settlement_id)
      .first();
    expect(row).toMatchObject({
      match_status: "matched",
      match_method: "settlement_ref",
      matched_request_id: purchase.request_id,
    });

    const rematchEvent = await env.DB.prepare(
      `SELECT payload_json FROM ledger_events
       WHERE org_id = ? AND request_id = ? AND event_type = 'settlement_matched'
       ORDER BY seq DESC LIMIT 1`
    )
      .bind(orgId, early.results[0].settlement_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(rematchEvent!.payload_json)).toMatchObject({ rematch: true });
  });

  it("batch-ingests, reporting per-item results including bad records", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/settlements`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-key": "test-admin-key",
        },
        body: JSON.stringify({
          rail: "card",
          settlements: [
            {
              auth_code: "AUTH-B1",
              merchant: "BatchVendor",
              amount_cents: 5_00,
              currency: "USD",
              posted_at: new Date().toISOString(),
            },
            { merchant: "Broken Record" },
          ],
        }),
      }
    );
    const body = await res.json<IngestResult>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].match_status).toBe("unauthorized");
    expect(body.results[1].error).toContain("settlement reference");
  });

  it("keeps the ledger chain intact and rejects bad admin keys", async () => {
    expect(await verifyLedgerChain(env.DB, orgId)).toMatchObject({ ok: true });
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/settlements`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "wrong" },
        body: JSON.stringify({ rail: "card" }),
      }
    );
    expect(res.status).toBe(401);
  });
});
