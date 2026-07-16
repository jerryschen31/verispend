// Compliance reports (Phase 4): a signed, audit-ready attestation that maps
// the org's ledger evidence to framework controls (see compliance-map.ts).
// Follows the receipt pattern exactly: the Ed25519 signature covers the
// verbatim payload_json string, key published at /.well-known, ledger
// anchors tie the claims into the tamper-evident chain, and the whole
// document verifies offline (scripts/verify-report.ts).
//
// Positioning: the report presents EVIDENCE relevant to controls. It never
// asserts compliance — that judgment belongs to the customer's auditor.

import { b64url, sha256Hex } from "./hash";
import { verifyLedgerChain, type ChainVerification } from "./ledger";
import {
  getActivePolicy,
  getLedgerChainHead,
  getOrg,
  insertComplianceReport,
  type ComplianceReportRow,
} from "./db";
import {
  computeKeyId,
  parseSigningJwk,
  publicJwkFromPrivate,
} from "./receipts";
import { resolveBreakerRules, type PolicyRules } from "./policy";
import {
  COMPLIANCE_MAP_VERSION,
  CONTROL_MAPPINGS,
  FRAMEWORKS,
  type ConfigCheck,
  type EvidenceQuery,
  type ExceptionScan,
  type Framework,
} from "./compliance-map";

export const POSITIONING =
  "This report presents machine-generated evidence from VeriSpend's " +
  "tamper-evident ledger, mapped to the listed framework controls. It is " +
  "evidence supporting an audit, not a certification of compliance; " +
  "compliance judgments belong to the organization and its auditors.";

const RECIPE =
  "Import signature.public_key_jwk as an Ed25519 verification key (Web " +
  "Crypto JWK). Verify signature.sig (base64url) over the exact UTF-8 " +
  "bytes of payload_json. Recompute signature.key_id as the first 16 hex " +
  'chars of SHA-256 over the JSON string {"crv":...,"kty":...,"x":...} ' +
  "built from the public key. Cross-check key_id against GET " +
  "/.well-known/verispend-keys.json. Optionally confirm the ledger_anchor " +
  "hashes appear in an audit bundle for this org " +
  "(scripts/verify-report.ts does all of this).";

export type EvidenceStatus = "evidenced" | "no_activity" | "attention";

export type ResolvedEvidence = {
  kind: EvidenceQuery["kind"];
  label: string;
  status: EvidenceStatus;
  detail: string;
  /** Ledger proof points: first event per matched type. */
  refs?: Array<{ seq: number; event_type: string; hash: string }>;
};

export type ResolvedControl = {
  control_id: string;
  title: string;
  rationale: string;
  status: EvidenceStatus;
  evidence: ResolvedEvidence[];
};

export type ReportDocument = {
  format: "verispend-compliance-report";
  version: 1;
  report_id: string;
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
  verification_recipe: { instructions: string };
};

export type ReportPayload = {
  report_id: string;
  generated_at: string;
  issued_by: string;
  compliance_map_version: number;
  positioning: string;
  org: { id: string; name: string };
  period: { start: string | null; end: string | null };
  chain_verification: ChainVerification & { verified_at: string };
  activity: {
    purchases: {
      total: number;
      by_status: Record<string, number>;
      denied_by_rule: Record<string, number>;
      requested_cents: number;
    };
    events_by_type: Record<string, number>;
    bills_by_recon_status: Record<string, number>;
    settlements_by_match_status: Record<string, number>;
    mandates: { verified: number; rejected: number };
    receipts_issued: number;
  };
  frameworks: Array<{
    id: Framework;
    name: string;
    note: string;
    summary: Record<EvidenceStatus, number>;
    controls: ResolvedControl[];
  }>;
  exceptions: {
    unauthorized_charges: Array<{
      id: string;
      rail: string;
      vendor: string;
      amount_cents: number;
      occurred_at: string;
    }>;
    overbilled_bills: Array<{
      id: string;
      vendor: string;
      amount_cents: number;
      variance_cents: number | null;
    }>;
    settlement_amount_mismatches: Array<{
      id: string;
      rail: string;
      vendor: string;
      variance_cents: number | null;
      matched_request_id: string | null;
    }>;
    frozen_agents: Array<{ agent_id: string; frozen_at: string; reason: string }>;
    policy_changes: Array<{ seq: number; version: unknown; edited_by: unknown; at: string }>;
  };
  ledger_anchor: {
    first_event: { seq: number; hash: string } | null;
    last_event: { seq: number; hash: string } | null;
    chain_head: { seq: number; hash: string } | null;
  };
};

export type Period = { start?: string; end?: string };

type Ctx = {
  db: D1Database;
  orgId: string;
  period: Period;
  policy: PolicyRules | null;
  eventCounts: Record<string, number>;
  eventSamples: Map<string, { seq: number; event_type: string; hash: string }>;
  exceptions: ReportPayload["exceptions"];
  chain: ChainVerification;
};

/** Inclusive YYYY-MM-DD bounds against date(created_at), like export.ts. */
function periodWhere(period: Period, column = "created_at") {
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (period.start) {
    clauses.push(`date(${column}) >= date(?)`);
    bindings.push(period.start);
  }
  if (period.end) {
    clauses.push(`date(${column}) <= date(?)`);
    bindings.push(period.end);
  }
  return { clause: clauses.map((c) => ` AND ${c}`).join(""), bindings };
}

async function countsBy(
  db: D1Database,
  orgId: string,
  period: Period,
  table: string,
  column: string
): Promise<Record<string, number>> {
  const { clause, bindings } = periodWhere(period);
  const { results } = await db
    .prepare(
      `SELECT ${column} AS k, COUNT(*) AS n FROM ${table}
       WHERE org_id = ?${clause} GROUP BY ${column}`
    )
    .bind(orgId, ...bindings)
    .all<{ k: string | null; n: number }>();
  return Object.fromEntries(results.map((r) => [r.k ?? "unknown", r.n]));
}

function checkConfig(policy: PolicyRules | null, check: ConfigCheck): boolean {
  if (!policy) return false;
  switch (check) {
    case "policy_exists":
      return true;
    case "transaction_cap_configured":
      return policy.maxPerTransactionCents !== undefined;
    case "escalation_configured":
      return (
        policy.escalation?.amountCents !== undefined ||
        (policy.escalation?.categories?.length ?? 0) > 0
      );
    case "budgets_configured":
      return Boolean(
        policy.budgets &&
          (policy.budgets.org ||
            policy.budgets.perAgent ||
            Object.keys(policy.budgets.agents ?? {}).length > 0 ||
            Object.keys(policy.budgets.teams ?? {}).length > 0)
      );
    case "breaker_enabled":
      return resolveBreakerRules(policy).enabled;
    case "vendor_rules_configured":
      return (
        (policy.vendors?.allow?.length ?? 0) > 0 ||
        (policy.vendors?.deny?.length ?? 0) > 0
      );
    case "mandates_required":
      return policy.mandates?.require !== undefined;
  }
}

function scanFindings(ctx: Ctx, scan: ExceptionScan): number {
  switch (scan) {
    case "unauthorized_charges":
      return ctx.exceptions.unauthorized_charges.length;
    case "overbilled_bills":
      return ctx.exceptions.overbilled_bills.length;
    case "settlement_amount_mismatches":
      return ctx.exceptions.settlement_amount_mismatches.length;
    case "unresolved_breaker_trips":
      return ctx.exceptions.frozen_agents.length;
  }
}

function resolveEvidence(ctx: Ctx, query: EvidenceQuery): ResolvedEvidence {
  switch (query.kind) {
    case "chain_verified":
      return ctx.chain.ok
        ? {
            kind: query.kind,
            label: "hash chain",
            status: "evidenced",
            detail: `chain verified: ${ctx.chain.count} events, none altered`,
          }
        : {
            kind: query.kind,
            label: "hash chain",
            status: "attention",
            detail: `chain broken at seq ${ctx.chain.brokenAtSeq}: ${ctx.chain.reason}`,
          };
    case "event_present": {
      const count = query.eventTypes.reduce(
        (sum, t) => sum + (ctx.eventCounts[t] ?? 0),
        0
      );
      const refs = query.eventTypes
        .map((t) => ctx.eventSamples.get(t))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
      return count > 0
        ? {
            kind: query.kind,
            label: query.label,
            status: "evidenced",
            detail: `${count} event${count === 1 ? "" : "s"} in period (${query.eventTypes.join(", ")})`,
            refs,
          }
        : {
            kind: query.kind,
            label: query.label,
            status: "no_activity",
            detail: `no ${query.eventTypes.join("/")} events in period`,
          };
    }
    case "config_state": {
      const on = checkConfig(ctx.policy, query.check);
      return {
        kind: query.kind,
        label: query.label,
        status: on ? "evidenced" : "no_activity",
        detail: on
          ? `${query.check} is configured in the active policy`
          : `${query.check} is not configured in the active policy`,
      };
    }
    case "exception_scan": {
      const findings = scanFindings(ctx, query.scan);
      return findings === 0
        ? {
            kind: query.kind,
            label: query.label,
            status: "evidenced",
            detail: `clean: no ${query.scan.replaceAll("_", " ")} found`,
          }
        : {
            kind: query.kind,
            label: query.label,
            status: "attention",
            detail: `${findings} finding${findings === 1 ? "" : "s"} — see exceptions`,
          };
    }
  }
}

/** attention beats evidenced beats no_activity. */
function combineStatuses(statuses: EvidenceStatus[]): EvidenceStatus {
  if (statuses.includes("attention")) return "attention";
  if (statuses.includes("evidenced")) return "evidenced";
  return "no_activity";
}

export type BuildReportResult =
  | { ok: true; report: ReportDocument }
  | { ok: false; error: string };

export async function buildComplianceReport(
  env: Env,
  args: { orgId: string; period?: Period; issuedBy: string }
): Promise<BuildReportResult> {
  const db = env.DB;
  const { orgId, issuedBy } = args;
  const period = args.period ?? {};
  const org = await getOrg(db, orgId);
  if (!org) return { ok: false, error: "no such org" };

  const activePolicy = await getActivePolicy(db, orgId);
  const chain = await verifyLedgerChain(db, orgId);
  const { clause, bindings } = periodWhere(period);

  // One pass over the period's events: counts per type plus the first
  // event of each type as a citable proof point.
  const eventCounts = await countsBy(db, orgId, period, "ledger_events", "event_type");
  const { results: sampleRows } = await db
    .prepare(
      `SELECT seq, event_type, hash FROM ledger_events
       WHERE org_id = ? AND seq IN (
         SELECT MIN(seq) FROM ledger_events WHERE org_id = ?${clause} GROUP BY event_type
       )`
    )
    .bind(orgId, orgId, ...bindings)
    .all<{ seq: number; event_type: string; hash: string }>();
  const eventSamples = new Map(sampleRows.map((r) => [r.event_type, r]));

  const { results: unauthorized } = await db
    .prepare(
      `SELECT id, rail, vendor, amount_cents, occurred_at FROM settlements
       WHERE org_id = ? AND match_status = 'unauthorized'${clause} ORDER BY occurred_at`
    )
    .bind(orgId, ...bindings)
    .all<ReportPayload["exceptions"]["unauthorized_charges"][number]>();
  const { results: mismatches } = await db
    .prepare(
      `SELECT id, rail, vendor, variance_cents, matched_request_id FROM settlements
       WHERE org_id = ? AND match_status = 'amount_mismatch'${clause} ORDER BY occurred_at`
    )
    .bind(orgId, ...bindings)
    .all<ReportPayload["exceptions"]["settlement_amount_mismatches"][number]>();
  const { results: overbilled } = await db
    .prepare(
      `SELECT id, vendor, amount_cents, variance_cents FROM billed_charges
       WHERE org_id = ? AND recon_status = 'overbilled'${clause} ORDER BY created_at`
    )
    .bind(orgId, ...bindings)
    .all<ReportPayload["exceptions"]["overbilled_bills"][number]>();
  const { results: policyChanges } = await db
    .prepare(
      `SELECT seq, payload_json, created_at FROM ledger_events
       WHERE org_id = ? AND event_type = 'policy_updated'${clause} ORDER BY seq`
    )
    .bind(orgId, ...bindings)
    .all<{ seq: number; payload_json: string; created_at: string }>();
  const frozen = await env.ORG.getByName(orgId).frozenAgents();

  const exceptions: ReportPayload["exceptions"] = {
    unauthorized_charges: unauthorized,
    overbilled_bills: overbilled,
    settlement_amount_mismatches: mismatches,
    frozen_agents: frozen.map((f) => ({
      agent_id: f.agent_id,
      frozen_at: f.frozen_at,
      reason: f.reason,
    })),
    policy_changes: policyChanges.map((p) => {
      const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
      return {
        seq: p.seq,
        version: payload.version,
        edited_by: payload.editedBy,
        at: p.created_at,
      };
    }),
  };

  const ctx: Ctx = {
    db,
    orgId,
    period,
    policy: activePolicy?.rules ?? null,
    eventCounts,
    eventSamples,
    exceptions,
    chain,
  };

  const frameworks = (Object.keys(FRAMEWORKS) as Framework[]).map((id) => {
    const controls = CONTROL_MAPPINGS.filter((m) => m.framework === id).map(
      (mapping): ResolvedControl => {
        const evidence = mapping.evidence.map((q) => resolveEvidence(ctx, q));
        return {
          control_id: mapping.controlId,
          title: mapping.title,
          rationale: mapping.rationale,
          status: combineStatuses(evidence.map((e) => e.status)),
          evidence,
        };
      }
    );
    const summary: Record<EvidenceStatus, number> = {
      evidenced: 0,
      no_activity: 0,
      attention: 0,
    };
    for (const control of controls) summary[control.status]++;
    return { id, ...FRAMEWORKS[id], summary, controls };
  });

  // Purchase activity summary.
  const byStatus = await countsBy(db, orgId, period, "purchase_requests", "status");
  const { results: deniedRules } = await db
    .prepare(
      `SELECT rule_fired AS k, COUNT(*) AS n FROM purchase_requests
       WHERE org_id = ? AND status = 'denied'${clause} GROUP BY rule_fired`
    )
    .bind(orgId, ...bindings)
    .all<{ k: string | null; n: number }>();
  const requested = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents
       FROM purchase_requests WHERE org_id = ?${clause}`
    )
    .bind(orgId, ...bindings)
    .first<{ n: number; cents: number }>();
  const receiptCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM receipts WHERE org_id = ?${clause}`
    )
    .bind(orgId, ...bindings)
    .first<{ n: number }>();
  const mandateCounts = await countsBy(
    db,
    orgId,
    period,
    "payment_mandates",
    "verification_status"
  );
  const mandatesVerified = mandateCounts.verified ?? 0;
  const mandatesRejected = Object.entries(mandateCounts)
    .filter(([k]) => k !== "verified")
    .reduce((sum, [, n]) => sum + n, 0);

  // Anchor: the period's first/last events plus the chain head, captured
  // BEFORE the report_generated event so the report never references itself.
  const boundary = async (order: "ASC" | "DESC") =>
    db
      .prepare(
        `SELECT seq, hash FROM ledger_events WHERE org_id = ?${clause}
         ORDER BY seq ${order} LIMIT 1`
      )
      .bind(orgId, ...bindings)
      .first<{ seq: number; hash: string }>();

  const reportId = `crpt_${crypto.randomUUID()}`;
  const payload: ReportPayload = {
    report_id: reportId,
    generated_at: new Date().toISOString(),
    issued_by: issuedBy,
    compliance_map_version: COMPLIANCE_MAP_VERSION,
    positioning: POSITIONING,
    org: { id: orgId, name: org.name },
    period: { start: period.start ?? null, end: period.end ?? null },
    chain_verification: { ...chain, verified_at: new Date().toISOString() },
    activity: {
      purchases: {
        total: requested?.n ?? 0,
        by_status: byStatus,
        denied_by_rule: Object.fromEntries(
          deniedRules.map((r) => [r.k ?? "unknown", r.n])
        ),
        requested_cents: requested?.cents ?? 0,
      },
      events_by_type: eventCounts,
      bills_by_recon_status: await countsBy(db, orgId, period, "billed_charges", "recon_status"),
      settlements_by_match_status: await countsBy(db, orgId, period, "settlements", "match_status"),
      mandates: { verified: mandatesVerified, rejected: mandatesRejected },
      receipts_issued: receiptCount?.n ?? 0,
    },
    frameworks,
    exceptions,
    ledger_anchor: {
      first_event: await boundary("ASC"),
      last_event: await boundary("DESC"),
      chain_head: await getLedgerChainHead(db, orgId),
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

  const report: ReportDocument = {
    format: "verispend-compliance-report",
    version: 1,
    report_id: reportId,
    issued_at: payload.generated_at,
    payload_json: payloadJson,
    signature: {
      alg: "Ed25519",
      key_id: keyId,
      public_key_jwk: publicJwk,
      sig: b64url(sig),
    },
    verification_recipe: { instructions: RECIPE },
  };

  const row: Omit<ComplianceReportRow, "created_at"> = {
    id: reportId,
    org_id: orgId,
    period_start: period.start ?? null,
    period_end: period.end ?? null,
    key_id: keyId,
    payload_hash: await sha256Hex(payloadJson),
    report_json: JSON.stringify(report),
    issued_by: issuedBy,
  };
  await insertComplianceReport(db, row);
  await env.ORG.getByName(orgId).appendEvent({
    orgId,
    requestId: reportId,
    eventType: "report_generated",
    payload: {
      reportId,
      payloadHash: row.payload_hash,
      keyId,
      issuedBy,
      periodStart: period.start ?? null,
      periodEnd: period.end ?? null,
    },
  });

  return { ok: true, report };
}
