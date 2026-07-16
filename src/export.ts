// Auditor-facing exports: filtered CSVs of every record type, plus a
// self-verifiable JSON audit bundle carrying the full hash chain and the
// recipe to re-verify it independently of this codebase.

import { verifyLedgerChain, type ChainVerification } from "./ledger";
import {
  getOrg,
  listAgentKeys,
  listMandateIssuers,
  listMembers,
  listTeamAgents,
  listTeamApprovers,
  listTeams,
} from "./db";

/** All exports cap at this many rows; noted in the dashboard UI. */
export const EXPORT_ROW_LIMIT = 10_000;

/** Exports are data egress; each download is itself recorded on the chain. */
export async function appendExportEvent(
  env: Env,
  orgId: string,
  exportType: string,
  by: string,
  filters?: Record<string, string | undefined>
): Promise<void> {
  const applied = Object.fromEntries(
    Object.entries(filters ?? {}).filter(([, v]) => v !== undefined && v !== "")
  );
  await env.ORG.getByName(orgId).appendEvent({
    orgId,
    requestId: "export",
    eventType: "export_generated",
    payload: {
      exportType,
      by,
      ...(Object.keys(applied).length > 0 ? { filters: applied } : {}),
    },
  });
}

const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = rows.map((row) => row.map(esc).join(","));
  return [header.join(","), ...lines].join("\n");
}

/** Inclusive YYYY-MM-DD bounds compared against date(created_at). */
export type DateRange = { from?: string; to?: string };

type Filter = { clause: string; binding: unknown };

function buildWhere(orgId: string, filters: Filter[]) {
  const active = filters.filter(
    (f) => f.binding !== undefined && f.binding !== ""
  );
  return {
    where: ["org_id = ?", ...active.map((f) => f.clause)].join(" AND "),
    bindings: [orgId, ...active.map((f) => f.binding)],
  };
}

const dateFilters = (range: DateRange): Filter[] => [
  { clause: "date(created_at) >= date(?)", binding: range.from },
  { clause: "date(created_at) <= date(?)", binding: range.to },
];

export async function exportPurchasesCsv(
  db: D1Database,
  orgId: string,
  f: DateRange & { agentId?: string; status?: string; teamId?: string }
): Promise<string> {
  const { where, bindings } = buildWhere(orgId, [
    ...dateFilters(f),
    { clause: "agent_id = ?", binding: f.agentId },
    { clause: "status = ?", binding: f.status },
    {
      clause:
        "agent_id IN (SELECT agent_id FROM team_agents WHERE team_agents.org_id = purchase_requests.org_id AND team_id = ?)",
      binding: f.teamId,
    },
  ]);
  const { results } = await db
    .prepare(
      `SELECT * FROM purchase_requests WHERE ${where}
       ORDER BY created_at, id LIMIT ${EXPORT_ROW_LIMIT}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const cols = [
    "id", "created_at", "agent_id", "vendor", "amount_cents", "currency",
    "category", "justification", "status", "rule_fired", "denial_reason",
    "approver", "decided_at", "outcome_amount_cents",
  ];
  return toCsv(cols, results.map((r) => cols.map((c) => r[c])));
}

export async function exportLedgerEventsCsv(
  db: D1Database,
  orgId: string,
  f: DateRange & { eventType?: string }
): Promise<string> {
  const { where, bindings } = buildWhere(orgId, [
    ...dateFilters(f),
    { clause: "event_type = ?", binding: f.eventType },
  ]);
  const { results } = await db
    .prepare(
      `SELECT * FROM ledger_events WHERE ${where}
       ORDER BY seq LIMIT ${EXPORT_ROW_LIMIT}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const cols = [
    "seq", "created_at", "request_id", "event_type", "payload_json",
    "prev_hash", "hash",
  ];
  return toCsv(cols, results.map((r) => cols.map((c) => r[c])));
}

export async function exportUsageCsv(
  db: D1Database,
  orgId: string,
  f: DateRange & { agentId?: string; vendor?: string }
): Promise<string> {
  const { where, bindings } = buildWhere(orgId, [
    ...dateFilters(f),
    { clause: "agent_id = ?", binding: f.agentId },
    { clause: "LOWER(TRIM(vendor)) = LOWER(TRIM(?))", binding: f.vendor },
  ]);
  const { results } = await db
    .prepare(
      `SELECT * FROM usage_records WHERE ${where}
       ORDER BY created_at, id LIMIT ${EXPORT_ROW_LIMIT}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const cols = [
    "id", "created_at", "agent_id", "vendor", "metric", "units",
    "expected_cost_cents", "note",
  ];
  return toCsv(cols, results.map((r) => cols.map((c) => r[c])));
}

export async function exportBillsCsv(
  db: D1Database,
  orgId: string,
  f: DateRange & { vendor?: string }
): Promise<string> {
  const { where, bindings } = buildWhere(orgId, [
    ...dateFilters(f),
    { clause: "LOWER(TRIM(vendor)) = LOWER(TRIM(?))", binding: f.vendor },
  ]);
  const { results } = await db
    .prepare(
      `SELECT * FROM billed_charges WHERE ${where}
       ORDER BY created_at, id LIMIT ${EXPORT_ROW_LIMIT}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const cols = [
    "id", "created_at", "vendor", "period_start", "period_end",
    "amount_cents", "expected_cents", "variance_cents", "recon_status", "memo",
  ];
  return toCsv(cols, results.map((r) => cols.map((c) => r[c])));
}

export async function exportSettlementsCsv(
  db: D1Database,
  orgId: string,
  f: DateRange & { rail?: string; matchStatus?: string }
): Promise<string> {
  const { where, bindings } = buildWhere(orgId, [
    ...dateFilters(f),
    { clause: "rail = ?", binding: f.rail },
    { clause: "match_status = ?", binding: f.matchStatus },
  ]);
  const cols = [
    "id", "created_at", "rail", "settlement_ref", "vendor", "amount_cents",
    "currency", "occurred_at", "match_status", "match_method",
    "matched_request_id", "variance_cents", "entered_by",
  ];
  // Column list, not SELECT *: settlements.raw_json can be large and isn't
  // emitted, so pulling it into every export row wastes memory for nothing.
  const { results } = await db
    .prepare(
      `SELECT ${cols.join(", ")} FROM settlements WHERE ${where}
       ORDER BY created_at, id LIMIT ${EXPORT_ROW_LIMIT}`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  return toCsv(cols, results.map((r) => cols.map((c) => r[c])));
}

export type AuditBundle = {
  format: "verispend-audit-bundle";
  version: 2;
  generated_at: string;
  org: { id: string; name: string };
  /** Every policy version, rules verbatim, so decisions can be re-read. */
  policies: Array<{ version: number; rules_json: string; created_at: string }>;
  /**
   * Control-plane state at export time (v2): who holds access and which
   * trust roots are registered — the reference data an auditor reads the
   * chain's control-plane events against. Never includes key hashes or
   * other secret material.
   */
  control_plane: {
    members: Array<{ id: string; email: string; role: string; created_at: string }>;
    agent_keys: Array<{
      id: string;
      agent_id: string;
      created_at: string;
      revoked_at: string | null;
    }>;
    issuers: Array<{
      id: string;
      issuer: string;
      scheme: string;
      alg: string;
      created_at: string;
      revoked_at: string | null;
    }>;
    teams: Array<{
      id: string;
      name: string;
      agents: string[];
      approvers: string[];
    }>;
  };
  verification: ChainVerification & { verified_at: string };
  hash_recipe: {
    algorithm: "SHA-256";
    genesis_prev_hash: "genesis";
    input_fields: [
      "prev_hash", "org_id", "request_id", "event_type", "payload_json", "created_at",
    ];
    separator: "\n";
    instructions: string;
  };
  /** payload_json is verbatim — re-stringifying would break the hashes. */
  events: Array<{
    seq: number;
    request_id: string;
    event_type: string;
    payload_json: string;
    prev_hash: string;
    hash: string;
    created_at: string;
  }>;
};

/**
 * The bundle always carries the full chain from genesis: a date-ranged chain
 * cannot self-verify. Date filters belong to the CSV exports.
 */
export async function buildAuditBundle(
  db: D1Database,
  orgId: string
): Promise<AuditBundle> {
  const org = await getOrg(db, orgId);
  const verification = await verifyLedgerChain(db, orgId);
  const { results: events } = await db
    .prepare(
      `SELECT seq, request_id, event_type, payload_json, prev_hash, hash, created_at
       FROM ledger_events WHERE org_id = ? ORDER BY seq ASC`
    )
    .bind(orgId)
    .all<AuditBundle["events"][number]>();
  const { results: policies } = await db
    .prepare(
      "SELECT version, rules_json, created_at FROM policies WHERE org_id = ? ORDER BY version ASC"
    )
    .bind(orgId)
    .all<AuditBundle["policies"][number]>();

  const teams = await listTeams(db, orgId);
  const controlPlane: AuditBundle["control_plane"] = {
    members: (await listMembers(db, orgId)).map((m) => ({
      id: m.id,
      email: m.email,
      role: m.role,
      created_at: m.created_at,
    })),
    agent_keys: (await listAgentKeys(db, orgId)).map((k) => ({
      id: k.id,
      agent_id: k.agent_id,
      created_at: k.created_at,
      revoked_at: k.revoked_at,
    })),
    issuers: (await listMandateIssuers(db, orgId)).map((i) => ({
      id: i.id,
      issuer: i.issuer,
      scheme: i.scheme,
      alg: i.alg,
      created_at: i.created_at,
      revoked_at: i.revoked_at,
    })),
    teams: await Promise.all(
      teams.map(async (t) => ({
        id: t.id,
        name: t.name,
        agents: await listTeamAgents(db, t.id),
        approvers: (await listTeamApprovers(db, t.id)).map((a) => a.email),
      }))
    ),
  };

  return {
    format: "verispend-audit-bundle",
    version: 2,
    generated_at: new Date().toISOString(),
    org: { id: orgId, name: org?.name ?? "" },
    policies,
    control_plane: controlPlane,
    verification: { ...verification, verified_at: new Date().toISOString() },
    hash_recipe: {
      algorithm: "SHA-256",
      genesis_prev_hash: "genesis",
      input_fields: [
        "prev_hash", "org_id", "request_id", "event_type", "payload_json", "created_at",
      ],
      separator: "\n",
      instructions:
        "For each event in ascending seq: assert prev_hash equals the previous event's hash ('genesis' for the first); compute the SHA-256 hex digest of the six input_fields joined by the separator; assert it equals hash.",
    },
    events,
  };
}
