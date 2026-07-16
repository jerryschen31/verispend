// Cross-rail settlement ingestion and matching (Phase 3). A settlement is the
// rail's after-the-fact record of what was actually charged. Ingestion is
// push/upload only — VeriSpend never calls a payment platform. Each record is
// normalized by a shallow rail adapter, then matched to a purchase request in
// three tiers: the agent-reported settlement_ref, our approval_ref echoed
// back by the rail, then a vendor/amount/time heuristic. A charge that
// matches nothing is flagged as unauthorized and alerted.

import {
  findHeuristicMatchCandidates,
  getActivePolicy,
  getOrg,
  getRequestByApprovalRef,
  getRequestBySettlementRef,
  getSettlementByRef,
  insertSettlement,
  type PurchaseRequestRow,
  type SettlementRow,
} from "./db";
import { resolveReconciliationRules } from "./reconcile";
import {
  resolveApprovers,
  sendSettlementMismatchEmail,
  sendUnauthorizedChargeEmail,
} from "./approvals";
import type { ReconciliationRules } from "./policy";

export const SETTLEMENT_RAILS = [
  "card",
  "stablecoin",
  "checkout",
  "stripe_event",
  "other",
] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

/** How far a settlement may land from the purchase decision and still match
 * heuristically. Rails post charges hours to days after authorization. */
const HEURISTIC_WINDOW_MS = 72 * 60 * 60 * 1000;

export type SettlementInput = {
  rail: SettlementRail;
  settlementRef: string;
  vendor: string;
  amountCents: number;
  currency: string;
  occurredAt: string; // ISO
  raw: unknown;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const intCents = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

const isoDate = (v: unknown): string | undefined => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return undefined;
  return new Date(Date.parse(v)).toISOString();
};

const unixToIsoDate = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? new Date(v * 1000).toISOString()
    : undefined;

type RawFields = {
  settlementRef?: string;
  vendor?: string;
  amountCents?: number;
  currency?: string;
  occurredAt?: string;
};

/**
 * Rail adapters: map each rail's payload shape onto the normalized input.
 * Deliberately shallow — field renames only, no protocol logic — so a rail's
 * format change is a mapping edit. Stablecoin amounts must arrive already
 * converted to fiat cents; VeriSpend does no currency conversion.
 */
function adaptRail(rail: SettlementRail, p: Record<string, unknown>): RawFields {
  switch (rail) {
    case "card":
      return {
        settlementRef: str(p.auth_code) ?? str(p.reference),
        vendor: str(p.merchant),
        amountCents: intCents(p.amount_cents),
        currency: str(p.currency),
        occurredAt: isoDate(p.posted_at),
      };
    case "stablecoin":
      return {
        settlementRef: str(p.tx_hash),
        vendor: str(p.payee) ?? str(p.memo),
        amountCents: intCents(p.amount_cents),
        currency: str(p.currency),
        occurredAt: isoDate(p.block_time),
      };
    case "checkout":
      return {
        settlementRef: str(p.order_id),
        vendor: str(p.merchant),
        amountCents: intCents(p.total_cents),
        currency: str(p.currency),
        occurredAt: isoDate(p.completed_at),
      };
    case "stripe_event": {
      // A charge.succeeded / payment_intent.succeeded-shaped event.
      const data = typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : {};
      const obj =
        typeof data.object === "object" && data.object !== null
          ? (data.object as Record<string, unknown>)
          : {};
      return {
        settlementRef: str(obj.id),
        vendor: str(obj.calculated_statement_descriptor) ?? str(obj.description),
        amountCents: intCents(obj.amount),
        currency: str(obj.currency)?.toUpperCase(),
        occurredAt: unixToIsoDate(obj.created),
      };
    }
    case "other":
      return {
        settlementRef: str(p.settlement_ref),
        vendor: str(p.vendor),
        amountCents: intCents(p.amount_cents),
        currency: str(p.currency),
        occurredAt: isoDate(p.occurred_at),
      };
  }
}

export function normalizeSettlement(
  rail: string,
  payload: Record<string, unknown>
): { ok: true; input: SettlementInput } | { ok: false; error: string } {
  if (!(SETTLEMENT_RAILS as readonly string[]).includes(rail)) {
    return { ok: false, error: `rail must be one of: ${SETTLEMENT_RAILS.join(", ")}` };
  }
  // Rail-native field names win; the normalized names ("other" shape) are
  // accepted on any rail so manual entry (the dashboard form) stays one form.
  const specific = adaptRail(rail as SettlementRail, payload);
  const generic = adaptRail("other", payload);
  const fields: RawFields = {
    settlementRef: specific.settlementRef ?? generic.settlementRef,
    vendor: specific.vendor ?? generic.vendor,
    amountCents: specific.amountCents ?? generic.amountCents,
    currency: specific.currency ?? generic.currency,
    occurredAt: specific.occurredAt ?? generic.occurredAt,
  };
  if (!fields.settlementRef) {
    return { ok: false, error: `missing the ${rail} rail's settlement reference` };
  }
  if (!fields.vendor) return { ok: false, error: "missing vendor" };
  if (fields.amountCents === undefined) {
    return { ok: false, error: "amount must be a positive integer of cents" };
  }
  if (!fields.occurredAt) {
    return { ok: false, error: "missing or unparseable settlement timestamp" };
  }
  return {
    ok: true,
    input: {
      rail: rail as SettlementRail,
      settlementRef: fields.settlementRef,
      vendor: fields.vendor,
      amountCents: fields.amountCents,
      currency: fields.currency ?? "USD",
      occurredAt: fields.occurredAt,
      raw: payload,
    },
  };
}

export type MatchStatus = "matched" | "amount_mismatch" | "unauthorized";
export type MatchMethod = "settlement_ref" | "approval_ref" | "heuristic" | "none";

export type MatchResult = {
  status: MatchStatus;
  method: MatchMethod;
  requestId: string | null;
  varianceCents: number;
};

/** The reference a settlement is compared against: what the agent reported
 * actually paying, falling back to what was approved. */
const referenceCents = (row: PurchaseRequestRow): number =>
  row.outcome_amount_cents ?? row.amount_cents;

export const allowedVariance = (
  reference: number,
  tolerance: Required<ReconciliationRules>
): number =>
  Math.max(tolerance.toleranceCents, (tolerance.tolerancePercent / 100) * reference);

/** Classify a ref-matched settlement's amount against the request. Pure. */
export function classifyMatch(args: {
  settledCents: number;
  referenceCents: number;
  tolerance: Required<ReconciliationRules>;
}): { status: Extract<MatchStatus, "matched" | "amount_mismatch">; varianceCents: number } {
  const varianceCents = args.settledCents - args.referenceCents;
  const allowed = allowedVariance(args.referenceCents, args.tolerance);
  return {
    status: Math.abs(varianceCents) <= allowed ? "matched" : "amount_mismatch",
    varianceCents,
  };
}

const withinWindow = (occurredAt: string, decidedAt: string): boolean => {
  const occurred = Date.parse(occurredAt);
  const decided = Date.parse(
    // created_at/decided_at come from SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" UTC.
    decidedAt.includes("T") ? decidedAt : `${decidedAt.replace(" ", "T")}Z`
  );
  return Math.abs(occurred - decided) <= HEURISTIC_WINDOW_MS;
};

export async function matchSettlement(
  db: D1Database,
  orgId: string,
  input: SettlementInput,
  tolerance: Required<ReconciliationRules>
): Promise<MatchResult> {
  // Tier 1: the agent reported this exact rail reference at record_outcome.
  const byRef = await getRequestBySettlementRef(db, orgId, input.settlementRef);
  if (byRef) {
    return {
      ...classifyMatch({
        settledCents: input.amountCents,
        referenceCents: referenceCents(byRef),
        tolerance,
      }),
      method: "settlement_ref",
      requestId: byRef.id,
    };
  }

  // Tier 2: some rails echo our approval_ref back as their reference.
  const byApproval = await getRequestByApprovalRef(db, orgId, input.settlementRef);
  if (byApproval) {
    return {
      ...classifyMatch({
        settledCents: input.amountCents,
        referenceCents: referenceCents(byApproval),
        tolerance,
      }),
      method: "approval_ref",
      requestId: byApproval.id,
    };
  }

  // Tier 3: heuristic — same vendor, amount within tolerance, decided within
  // ±72h, not already claimed by another settlement. Oldest candidate wins so
  // repeated identical purchases pair up in order.
  const candidates = await findHeuristicMatchCandidates(db, orgId, input.vendor);
  for (const candidate of candidates) {
    const reference = referenceCents(candidate);
    if (Math.abs(input.amountCents - reference) > allowedVariance(reference, tolerance)) {
      continue;
    }
    if (!withinWindow(input.occurredAt, candidate.decided_at ?? candidate.created_at)) {
      continue;
    }
    return {
      status: "matched",
      method: "heuristic",
      requestId: candidate.id,
      varianceCents: input.amountCents - reference,
    };
  }

  return { status: "unauthorized", method: "none", requestId: null, varianceCents: 0 };
}

export type IngestSettlementResult =
  | { ok: true; settlement: Omit<SettlementRow, "created_at">; duplicate: boolean }
  | { ok: false; error: string };

/** Normalize, match, persist, put it on the ledger, and alert on anomalies. */
export async function ingestSettlement(
  env: Env,
  args: {
    orgId: string;
    rail: string;
    payload: Record<string, unknown>;
    enteredBy: string;
  }
): Promise<IngestSettlementResult> {
  const normalized = normalizeSettlement(args.rail, args.payload);
  if (!normalized.ok) return normalized;
  const { input } = normalized;

  const existing = await getSettlementByRef(
    env.DB,
    args.orgId,
    input.rail,
    input.settlementRef
  );
  if (existing) {
    // Feeds get replayed; the first ingest already matched and ledgered it.
    return { ok: true, settlement: existing, duplicate: true };
  }

  const policy = await getActivePolicy(env.DB, args.orgId);
  const tolerance = resolveReconciliationRules(policy?.rules.reconciliation);
  const match = await matchSettlement(env.DB, args.orgId, input, tolerance);

  const settlement: Omit<SettlementRow, "created_at"> = {
    id: `stl_${crypto.randomUUID()}`,
    org_id: args.orgId,
    rail: input.rail,
    settlement_ref: input.settlementRef,
    vendor: input.vendor,
    amount_cents: input.amountCents,
    currency: input.currency,
    occurred_at: input.occurredAt,
    raw_json: JSON.stringify(input.raw),
    match_status: match.status,
    match_method: match.method,
    matched_request_id: match.requestId,
    variance_cents: match.varianceCents,
    entered_by: args.enteredBy,
  };
  await insertSettlement(env.DB, settlement);

  const coordinator = env.ORG.getByName(args.orgId);
  await coordinator.appendEvent({
    orgId: args.orgId,
    requestId: settlement.id,
    eventType: "settlement_ingested",
    payload: {
      rail: input.rail,
      settlementRef: input.settlementRef,
      vendor: input.vendor,
      amountCents: input.amountCents,
      currency: input.currency,
      occurredAt: input.occurredAt,
      enteredBy: args.enteredBy,
    },
  });
  await coordinator.appendEvent({
    orgId: args.orgId,
    requestId: settlement.id,
    eventType: "settlement_matched",
    payload: {
      status: match.status,
      method: match.method,
      matchedRequestId: match.requestId,
      varianceCents: match.varianceCents,
      tolerance,
    },
  });
  if (match.status === "unauthorized") {
    await coordinator.appendEvent({
      orgId: args.orgId,
      requestId: settlement.id,
      eventType: "unauthorized_charge",
      payload: {
        rail: input.rail,
        settlementRef: input.settlementRef,
        vendor: input.vendor,
        amountCents: input.amountCents,
        occurredAt: input.occurredAt,
      },
    });
  }

  if (match.status !== "matched") {
    const org = await getOrg(env.DB, args.orgId);
    const currency = policy?.rules.currency ?? "USD";
    // Settlements carry no agent context, so alerts go to org-wide recipients.
    const alertTo = await resolveApprovers(env.DB, args.orgId, null);
    for (const email of alertTo.emails) {
      if (match.status === "unauthorized") {
        await sendUnauthorizedChargeEmail(env, {
          approverEmail: email,
          orgName: org?.name ?? "your org",
          rail: input.rail,
          settlementRef: input.settlementRef,
          vendor: input.vendor,
          amountCents: input.amountCents,
          occurredAt: input.occurredAt,
          currency,
        });
      } else {
        await sendSettlementMismatchEmail(env, {
          approverEmail: email,
          orgName: org?.name ?? "your org",
          rail: input.rail,
          settlementRef: input.settlementRef,
          vendor: input.vendor,
          settledCents: input.amountCents,
          varianceCents: match.varianceCents,
          requestId: match.requestId ?? "unknown",
          currency,
        });
      }
    }
  }

  return { ok: true, settlement, duplicate: false };
}
