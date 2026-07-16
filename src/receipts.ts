// Verifiable receipts (Phase 3): a signed artifact proving a specific
// purchase was authorized, by whom, under what limits, and that it matched
// what actually settled — dispute evidence a company can hand to a card
// issuer or auditor. Signed locally with VeriSpend's Ed25519 key and
// verifiable offline via the embedded recipe (scripts/verify-receipt.ts);
// the anchored ledger hashes tie every claim into the tamper-evident chain.
//
// The signature covers the exact payload_json string, never a re-parsed
// object — the same canonicalization-free trick the ledger uses.

import { b64url, sha256Hex } from "./hash";
import {
  getLedgerChainHead,
  getMandateForRequest,
  getOrg,
  getPurchaseRequest,
  insertReceipt,
  listLedgerEventsForRequest,
  listSettlementsForRequest,
  type ReceiptRow,
} from "./db";

export type ReceiptDocument = {
  format: "verispend-receipt";
  version: 1;
  receipt_id: string;
  issued_at: string;
  /** Verbatim signing input; parse it for the claims, verify it as bytes. */
  payload_json: string;
  signature: {
    alg: "Ed25519";
    key_id: string;
    public_key_jwk: JsonWebKey;
    /** base64url signature over the UTF-8 bytes of payload_json. */
    sig: string;
  };
  verification_recipe: {
    instructions: string;
  };
};

const RECIPE =
  "Import public_key_jwk as an Ed25519 verification key (Web Crypto JWK). " +
  "Verify sig (base64url) over the exact UTF-8 bytes of payload_json. " +
  "Recompute key_id as the first 16 hex chars of SHA-256 over the JSON " +
  'string {"crv":...,"kty":...,"x":...} built from the public key. ' +
  "Cross-check key_id against GET /.well-known/verispend-keys.json. " +
  "Optionally confirm each ledger_anchor hash appears in an audit bundle " +
  "for this org (scripts/verify-receipt.ts does all of this).";

export function publicJwkFromPrivate(privateJwk: JsonWebKey): JsonWebKey {
  return { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x };
}

/** RFC 7638-style thumbprint over the public key's required members. */
export async function computeKeyId(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  });
  return (await sha256Hex(canonical)).slice(0, 16);
}

export function parseSigningJwk(env: Env): JsonWebKey {
  if (!env.RECEIPT_SIGNING_KEY) {
    throw new Error("RECEIPT_SIGNING_KEY secret is not configured");
  }
  // Keep only the required members; a full Node keygen export carries
  // optional fields (alg, key_ops) that workerd's importKey rejects.
  const raw = JSON.parse(env.RECEIPT_SIGNING_KEY) as JsonWebKey;
  return { kty: raw.kty, crv: raw.crv, x: raw.x, d: raw.d };
}

export type IssueReceiptResult =
  | { ok: true; receipt: ReceiptDocument }
  | { ok: false; error: string };

export async function issueReceipt(
  env: Env,
  args: { orgId: string; requestId: string; issuedBy: string }
): Promise<IssueReceiptResult> {
  const db = env.DB;
  const row = await getPurchaseRequest(db, args.orgId, args.requestId);
  if (!row) return { ok: false, error: `no request ${args.requestId} for this org` };
  if (row.status === "pending_approval") {
    return {
      ok: false,
      error: "request is still pending human approval — nothing final to attest yet",
    };
  }

  const org = await getOrg(db, args.orgId);
  const mandate = await getMandateForRequest(db, args.orgId, args.requestId);
  const settlements = await listSettlementsForRequest(db, args.orgId, args.requestId);
  const settlement = settlements.at(-1) ?? null;

  // Anchor every ledger event about this purchase (and its settlement) plus
  // the org chain head, captured BEFORE the receipt_issued event so the
  // receipt never has to reference itself.
  const requestEvents = await listLedgerEventsForRequest(db, args.orgId, args.requestId);
  const settlementEvents = settlement
    ? await listLedgerEventsForRequest(db, args.orgId, settlement.id)
    : [];
  const chainHead = await getLedgerChainHead(db, args.orgId);

  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const payload = {
    receipt_id: receiptId,
    org: { id: args.orgId, name: org?.name ?? "" },
    request: {
      id: row.id,
      agent_id: row.agent_id,
      vendor: row.vendor,
      amount_cents: row.amount_cents,
      currency: row.currency,
      category: row.category,
      justification: row.justification,
      created_at: row.created_at,
    },
    decision: {
      status: row.status,
      rule_fired: row.rule_fired,
      policy_version: row.policy_version,
      approval_ref: row.approval_ref,
      approver: row.approver,
      decided_at: row.decided_at,
    },
    mandate: mandate
      ? {
          scheme: mandate.scheme,
          issuer: mandate.issuer,
          subject: mandate.subject,
          mandate_ref: mandate.mandate_ref,
          scope: JSON.parse(mandate.scope_json) as Record<string, unknown>,
          expires_at: mandate.expires_at,
          token_hash: mandate.token_hash,
          verification_status: mandate.verification_status,
        }
      : null,
    outcome:
      row.outcome_amount_cents !== null
        ? {
            final_amount_cents: row.outcome_amount_cents,
            settlement_rail: row.settlement_rail,
            settlement_ref: row.settlement_ref,
          }
        : null,
    settlement: settlement
      ? {
          id: settlement.id,
          rail: settlement.rail,
          settlement_ref: settlement.settlement_ref,
          amount_cents: settlement.amount_cents,
          occurred_at: settlement.occurred_at,
          match_status: settlement.match_status,
          match_method: settlement.match_method,
          variance_cents: settlement.variance_cents,
        }
      : null,
    ledger_anchor: {
      events: [...requestEvents, ...settlementEvents]
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ seq: e.seq, event_type: e.event_type, hash: e.hash })),
      chain_head: chainHead,
    },
  };
  const payloadJson = JSON.stringify(payload);

  const privateJwk = parseSigningJwk(env);
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const keyId = await computeKeyId(publicJwk);
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(payloadJson)
  );

  const receipt: ReceiptDocument = {
    format: "verispend-receipt",
    version: 1,
    receipt_id: receiptId,
    issued_at: new Date().toISOString(),
    payload_json: payloadJson,
    signature: {
      alg: "Ed25519",
      key_id: keyId,
      public_key_jwk: publicJwk,
      sig: b64url(sig),
    },
    verification_recipe: { instructions: RECIPE },
  };

  const receiptRow: Omit<ReceiptRow, "created_at"> = {
    id: receiptId,
    org_id: args.orgId,
    request_id: args.requestId,
    key_id: keyId,
    payload_hash: await sha256Hex(payloadJson),
    receipt_json: JSON.stringify(receipt),
    issued_by: args.issuedBy,
  };
  await insertReceipt(db, receiptRow);
  await env.ORG.getByName(args.orgId).appendEvent({
    orgId: args.orgId,
    requestId: args.requestId,
    eventType: "receipt_issued",
    payload: {
      receiptId,
      payloadHash: receiptRow.payload_hash,
      keyId,
      issuedBy: args.issuedBy,
    },
  });

  return { ok: true, receipt };
}

/**
 * Keys for /.well-known/verispend-keys.json: the current signing key plus
 * every key that ever signed a stored receipt, so rotation never orphans an
 * old receipt's kid. Historical public keys are recovered from the receipts
 * themselves (each embeds its own).
 */
export async function listReceiptKeys(
  env: Env
): Promise<Array<JsonWebKey & { kid: string; use: string; alg: string }>> {
  const privateJwk = parseSigningJwk(env);
  const current = publicJwkFromPrivate(privateJwk);
  const keys = new Map<string, JsonWebKey>();
  keys.set(await computeKeyId(current), current);

  const { results } = await env.DB.prepare(
    `SELECT key_id, receipt_json FROM receipts
     WHERE id IN (SELECT MIN(id) FROM receipts GROUP BY key_id)`
  ).all<{ key_id: string; receipt_json: string }>();
  for (const row of results) {
    if (keys.has(row.key_id)) continue;
    const doc = JSON.parse(row.receipt_json) as ReceiptDocument;
    keys.set(row.key_id, doc.signature.public_key_jwk);
  }

  return [...keys.entries()].map(([kid, jwk]) => ({
    ...jwk,
    kid,
    use: "sig",
    alg: "Ed25519",
  }));
}
