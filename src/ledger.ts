// Append-only, hash-chained audit ledger in D1.
//
// Chain integrity requires appends for one org to be serialized: two writers
// reading the same tail hash would fork the chain. All writes therefore go
// through OrgCoordinator.appendEvent (one Durable Object per org), never
// directly from request handlers.

export type LedgerEventType =
  | "purchase_requested"
  | "auto_decision"
  | "approval_routed"
  | "human_decision"
  | "outcome_recorded"
  | "policy_updated"
  | "breaker_tripped"
  | "breaker_reset"
  | "usage_recorded"
  | "bill_ingested"
  | "bill_reconciled"
  | "mandate_verified"
  | "mandate_rejected";

export type LedgerAppend = {
  orgId: string;
  requestId: string;
  eventType: LedgerEventType;
  payload: Record<string, unknown>;
};

import { sha256Hex } from "./hash";

const GENESIS = "genesis";

function hashInput(
  prevHash: string,
  orgId: string,
  requestId: string,
  eventType: string,
  payloadJson: string,
  createdAt: string
): string {
  return [prevHash, orgId, requestId, eventType, payloadJson, createdAt].join(
    "\n"
  );
}

export async function appendLedgerEvent(
  db: D1Database,
  event: LedgerAppend
): Promise<{ seq: number; hash: string }> {
  const tail = await db
    .prepare(
      "SELECT hash FROM ledger_events WHERE org_id = ? ORDER BY seq DESC LIMIT 1"
    )
    .bind(event.orgId)
    .first<{ hash: string }>();
  const prevHash = tail?.hash ?? GENESIS;

  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(event.payload);
  const hash = await sha256Hex(
    hashInput(
      prevHash,
      event.orgId,
      event.requestId,
      event.eventType,
      payloadJson,
      createdAt
    )
  );

  const inserted = await db
    .prepare(
      `INSERT INTO ledger_events
         (org_id, request_id, event_type, payload_json, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`
    )
    .bind(
      event.orgId,
      event.requestId,
      event.eventType,
      payloadJson,
      prevHash,
      hash,
      createdAt
    )
    .first<{ seq: number }>();

  return { seq: inserted!.seq, hash };
}

export type ChainVerification =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: number; reason: string };

export async function verifyLedgerChain(
  db: D1Database,
  orgId: string
): Promise<ChainVerification> {
  const { results } = await db
    .prepare(
      `SELECT seq, request_id, event_type, payload_json, prev_hash, hash, created_at
       FROM ledger_events WHERE org_id = ? ORDER BY seq ASC`
    )
    .bind(orgId)
    .all<{
      seq: number;
      request_id: string;
      event_type: string;
      payload_json: string;
      prev_hash: string;
      hash: string;
      created_at: string;
    }>();

  let expectedPrev = GENESIS;
  for (const row of results) {
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: `prev_hash does not match the preceding event's hash`,
      };
    }
    const recomputed = await sha256Hex(
      hashInput(
        row.prev_hash,
        orgId,
        row.request_id,
        row.event_type,
        row.payload_json,
        row.created_at
      )
    );
    if (recomputed !== row.hash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: `stored hash does not match recomputed hash (row was altered)`,
      };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, count: results.length };
}
