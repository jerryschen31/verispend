import { sha256Hex } from "./hash";
import { generateApiKey } from "./auth";
import type { PolicyRules } from "./policy";

export type RequestStatus =
  | "approved"
  | "denied"
  | "pending_approval"
  | "completed"
  | "canceled";

export type PurchaseRequestRow = {
  id: string;
  org_id: string;
  agent_id: string;
  vendor: string;
  amount_cents: number;
  currency: string;
  category: string;
  justification: string;
  status: RequestStatus;
  policy_version: number;
  rule_fired: string | null;
  denial_reason: string | null;
  approval_ref: string | null;
  approver: string | null;
  decided_at: string | null;
  outcome_amount_cents: number | null;
  outcome_json: string | null;
  created_at: string;
};

export async function createOrg(
  db: D1Database,
  args: { name: string; approverEmail?: string }
): Promise<{ orgId: string }> {
  const orgId = `org_${crypto.randomUUID()}`;
  await db
    .prepare("INSERT INTO orgs (id, name, approver_email) VALUES (?, ?, ?)")
    .bind(orgId, args.name, args.approverEmail ?? null)
    .run();
  if (args.approverEmail?.trim()) {
    await upsertMember(db, { orgId, email: args.approverEmail, role: "admin" });
  }
  return { orgId };
}

// ---------- Org members (humans with dashboard roles) ----------

export type MemberRole = "admin" | "approver" | "viewer";

export const MEMBER_ROLES: readonly MemberRole[] = ["admin", "approver", "viewer"];

export type OrgMemberRow = {
  id: string;
  org_id: string;
  email: string;
  role: MemberRole;
  created_at: string;
};

/** Emails are stored and matched as lower(trim()); Kinde may mix case. */
const normEmail = (email: string) => email.trim().toLowerCase();

export async function listMembers(
  db: D1Database,
  orgId: string
): Promise<OrgMemberRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM org_members WHERE org_id = ? ORDER BY created_at, email"
    )
    .bind(orgId)
    .all<OrgMemberRow>();
  return results;
}

export async function getMembership(
  db: D1Database,
  orgId: string,
  email: string
): Promise<OrgMemberRow | null> {
  return db
    .prepare("SELECT * FROM org_members WHERE org_id = ? AND email = ?")
    .bind(orgId, normEmail(email))
    .first<OrgMemberRow>();
}

/** First membership for an email across orgs (oldest org wins, like the
 * legacy approver_email lookup). TODO: org picker for multi-org emails. */
export async function getFirstMembershipByEmail(
  db: D1Database,
  email: string
): Promise<OrgMemberRow | null> {
  return db
    .prepare(
      "SELECT * FROM org_members WHERE email = ? ORDER BY created_at, org_id LIMIT 1"
    )
    .bind(normEmail(email))
    .first<OrgMemberRow>();
}

export async function upsertMember(
  db: D1Database,
  args: { orgId: string; email: string; role: MemberRole }
): Promise<{ id: string }> {
  const id = `mem_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO org_members (id, org_id, email, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, email) DO UPDATE SET role = excluded.role`
    )
    .bind(id, args.orgId, normEmail(args.email), args.role)
    .run();
  const row = await getMembership(db, args.orgId, args.email);
  return { id: row?.id ?? id };
}

export async function deleteMember(
  db: D1Database,
  orgId: string,
  memberId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM org_members WHERE org_id = ? AND id = ?")
    .bind(orgId, memberId)
    .run();
}

export async function countAdmins(db: D1Database, orgId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'admin'"
    )
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getMemberById(
  db: D1Database,
  orgId: string,
  memberId: string
): Promise<OrgMemberRow | null> {
  return db
    .prepare("SELECT * FROM org_members WHERE org_id = ? AND id = ?")
    .bind(orgId, memberId)
    .first<OrgMemberRow>();
}

export async function getOrg(
  db: D1Database,
  orgId: string
): Promise<{ id: string; name: string; approver_email: string | null } | null> {
  return db
    .prepare("SELECT id, name, approver_email FROM orgs WHERE id = ?")
    .bind(orgId)
    .first();
}

export async function getOrgByApproverEmail(
  db: D1Database,
  email: string
): Promise<{ id: string; name: string; approver_email: string | null } | null> {
  return db
    .prepare(
      "SELECT id, name, approver_email FROM orgs WHERE approver_email = ? ORDER BY created_at LIMIT 1"
    )
    .bind(email)
    .first();
}

export async function listPurchaseRequests(
  db: D1Database,
  orgId: string,
  filters: { status?: RequestStatus; agentId?: string; limit?: number } = {}
): Promise<PurchaseRequestRow[]> {
  const conditions = ["org_id = ?"];
  const bindings: unknown[] = [orgId];
  if (filters.status) {
    conditions.push("status = ?");
    bindings.push(filters.status);
  }
  if (filters.agentId) {
    conditions.push("agent_id = ?");
    bindings.push(filters.agentId);
  }
  bindings.push(filters.limit ?? 100);
  const { results } = await db
    .prepare(
      `SELECT * FROM purchase_requests WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(...bindings)
    .all<PurchaseRequestRow>();
  return results;
}

export type AgentKeyRow = {
  id: string;
  agent_id: string;
  created_at: string;
  revoked_at: string | null;
};

export async function listAgentKeys(
  db: D1Database,
  orgId: string
): Promise<AgentKeyRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, agent_id, created_at, revoked_at FROM agent_keys WHERE org_id = ? ORDER BY created_at DESC"
    )
    .bind(orgId)
    .all<AgentKeyRow>();
  return results;
}

export async function revokeAgentKey(
  db: D1Database,
  orgId: string,
  keyId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE agent_keys SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL"
    )
    .bind(new Date().toISOString(), orgId, keyId)
    .run();
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export async function createAgentKey(
  db: D1Database,
  args: { orgId: string; agentId: string }
): Promise<{ apiKey: string }> {
  const apiKey = generateApiKey();
  await db
    .prepare(
      "INSERT INTO agent_keys (id, org_id, agent_id, key_hash) VALUES (?, ?, ?, ?)"
    )
    .bind(`key_${crypto.randomUUID()}`, args.orgId, args.agentId, await sha256Hex(apiKey))
    .run();
  return { apiKey };
}

export async function insertPolicy(
  db: D1Database,
  args: { orgId: string; rules: PolicyRules; sourceText?: string }
): Promise<{ version: number }> {
  const current = await db
    .prepare("SELECT MAX(version) AS v FROM policies WHERE org_id = ?")
    .bind(args.orgId)
    .first<{ v: number | null }>();
  const version = (current?.v ?? 0) + 1;
  await db
    .prepare(
      "INSERT INTO policies (id, org_id, version, rules_json, source_text) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(
      `pol_${crypto.randomUUID()}`,
      args.orgId,
      version,
      JSON.stringify(args.rules),
      args.sourceText ?? null
    )
    .run();
  return { version };
}

export async function getPolicyByVersion(
  db: D1Database,
  orgId: string,
  version: number
): Promise<{ version: number; rules: PolicyRules } | null> {
  const row = await db
    .prepare(
      "SELECT version, rules_json FROM policies WHERE org_id = ? AND version = ?"
    )
    .bind(orgId, version)
    .first<{ version: number; rules_json: string }>();
  if (!row) return null;
  return { version: row.version, rules: JSON.parse(row.rules_json) };
}

export async function getActivePolicy(
  db: D1Database,
  orgId: string
): Promise<{ version: number; rules: PolicyRules } | null> {
  const row = await db
    .prepare(
      "SELECT version, rules_json FROM policies WHERE org_id = ? ORDER BY version DESC LIMIT 1"
    )
    .bind(orgId)
    .first<{ version: number; rules_json: string }>();
  if (!row) return null;
  return { version: row.version, rules: JSON.parse(row.rules_json) };
}

export async function insertPurchaseRequest(
  db: D1Database,
  row: Omit<
    PurchaseRequestRow,
    "created_at" | "outcome_amount_cents" | "outcome_json" | "approver"
  > & { decision_token?: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO purchase_requests
         (id, org_id, agent_id, vendor, amount_cents, currency, category,
          justification, status, policy_version, rule_fired, denial_reason,
          approval_ref, decided_at, decision_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.org_id,
      row.agent_id,
      row.vendor,
      row.amount_cents,
      row.currency,
      row.category,
      row.justification,
      row.status,
      row.policy_version,
      row.rule_fired,
      row.denial_reason,
      row.approval_ref,
      row.decided_at,
      row.decision_token ?? null
    )
    .run();
}

export async function getRequestByDecisionToken(
  db: D1Database,
  decisionToken: string
): Promise<PurchaseRequestRow | null> {
  return db
    .prepare("SELECT * FROM purchase_requests WHERE decision_token = ?")
    .bind(decisionToken)
    .first<PurchaseRequestRow>();
}

export async function applyHumanDecision(
  db: D1Database,
  args: {
    orgId: string;
    requestId: string;
    status: "approved" | "denied";
    approver: string;
    approvalRef?: string;
    denialReason?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE purchase_requests
       SET status = ?, approver = ?, approval_ref = ?, denial_reason = ?,
           decided_at = ?
       WHERE org_id = ? AND id = ? AND status = 'pending_approval'`
    )
    .bind(
      args.status,
      args.approver,
      args.approvalRef ?? null,
      args.denialReason ?? null,
      new Date().toISOString(),
      args.orgId,
      args.requestId
    )
    .run();
}

export async function getPurchaseRequest(
  db: D1Database,
  orgId: string,
  requestId: string
): Promise<PurchaseRequestRow | null> {
  return db
    .prepare("SELECT * FROM purchase_requests WHERE org_id = ? AND id = ?")
    .bind(orgId, requestId)
    .first<PurchaseRequestRow>();
}

export type UsageRecordRow = {
  id: string;
  org_id: string;
  agent_id: string;
  vendor: string;
  metric: string;
  units: number;
  expected_cost_cents: number;
  note: string | null;
  created_at: string;
};

export async function insertUsageRecord(
  db: D1Database,
  row: Omit<UsageRecordRow, "created_at">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_records
         (id, org_id, agent_id, vendor, metric, units, expected_cost_cents, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.org_id,
      row.agent_id,
      row.vendor,
      row.metric,
      row.units,
      row.expected_cost_cents,
      row.note
    )
    .run();
}

export async function listUsageRecords(
  db: D1Database,
  orgId: string,
  limit = 100
): Promise<UsageRecordRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM usage_records WHERE org_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(orgId, limit)
    .all<UsageRecordRow>();
  return results;
}

/**
 * Sum of expected costs reported for a vendor over an inclusive date range.
 * Vendor matching uses the same trim/lowercase semantics as policy rules.
 */
export async function sumExpectedCost(
  db: D1Database,
  args: { orgId: string; vendor: string; periodStart: string; periodEnd: string }
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(expected_cost_cents), 0) AS total
       FROM usage_records
       WHERE org_id = ? AND LOWER(TRIM(vendor)) = LOWER(TRIM(?))
         AND date(created_at) >= date(?) AND date(created_at) <= date(?)`
    )
    .bind(args.orgId, args.vendor, args.periodStart, args.periodEnd)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export type BilledChargeRow = {
  id: string;
  org_id: string;
  vendor: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  memo: string | null;
  expected_cents: number;
  variance_cents: number;
  recon_status: string;
  created_at: string;
};

export async function insertBilledCharge(
  db: D1Database,
  row: Omit<BilledChargeRow, "created_at">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO billed_charges
         (id, org_id, vendor, period_start, period_end, amount_cents, memo,
          expected_cents, variance_cents, recon_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.org_id,
      row.vendor,
      row.period_start,
      row.period_end,
      row.amount_cents,
      row.memo,
      row.expected_cents,
      row.variance_cents,
      row.recon_status
    )
    .run();
}

export async function listBilledCharges(
  db: D1Database,
  orgId: string,
  limit = 100
): Promise<BilledChargeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM billed_charges WHERE org_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(orgId, limit)
    .all<BilledChargeRow>();
  return results;
}

export async function markOutcomeRecorded(
  db: D1Database,
  args: {
    orgId: string;
    requestId: string;
    outcomeAmountCents: number;
    outcomeJson: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE purchase_requests
       SET status = 'completed', outcome_amount_cents = ?, outcome_json = ?
       WHERE org_id = ? AND id = ? AND status = 'approved'`
    )
    .bind(args.outcomeAmountCents, args.outcomeJson, args.orgId, args.requestId)
    .run();
}
