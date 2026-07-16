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
  /** Team whose shared budget this purchase was reserved against, if any. */
  team_id: string | null;
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

// ---------- Teams (agent groups with shared budgets and approvers) ----------

export type TeamRow = {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
};

export async function createTeam(
  db: D1Database,
  args: { orgId: string; name: string }
): Promise<{ teamId: string }> {
  const teamId = `team_${crypto.randomUUID()}`;
  await db
    .prepare("INSERT INTO teams (id, org_id, name) VALUES (?, ?, ?)")
    .bind(teamId, args.orgId, args.name.trim())
    .run();
  return { teamId };
}

export async function listTeams(
  db: D1Database,
  orgId: string
): Promise<Array<TeamRow & { agent_count: number }>> {
  const { results } = await db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM team_agents ta WHERE ta.team_id = t.id) AS agent_count
       FROM teams t WHERE t.org_id = ? ORDER BY t.created_at, t.name`
    )
    .bind(orgId)
    .all<TeamRow & { agent_count: number }>();
  return results;
}

export async function getTeam(
  db: D1Database,
  orgId: string,
  teamId: string
): Promise<TeamRow | null> {
  return db
    .prepare("SELECT * FROM teams WHERE org_id = ? AND id = ?")
    .bind(orgId, teamId)
    .first<TeamRow>();
}

export async function getTeamForAgent(
  db: D1Database,
  orgId: string,
  agentId: string
): Promise<TeamRow | null> {
  return db
    .prepare(
      `SELECT t.* FROM teams t
       JOIN team_agents ta ON ta.team_id = t.id
       WHERE ta.org_id = ? AND ta.agent_id = ?`
    )
    .bind(orgId, agentId)
    .first<TeamRow>();
}

/** Assign an agent to a team (replacing any previous team) or, with a null
 * teamId, remove it from its team. */
export async function setAgentTeam(
  db: D1Database,
  args: { orgId: string; agentId: string; teamId: string | null }
): Promise<void> {
  if (args.teamId === null) {
    await db
      .prepare("DELETE FROM team_agents WHERE org_id = ? AND agent_id = ?")
      .bind(args.orgId, args.agentId)
      .run();
    return;
  }
  await db
    .prepare(
      "INSERT OR REPLACE INTO team_agents (org_id, team_id, agent_id) VALUES (?, ?, ?)"
    )
    .bind(args.orgId, args.teamId, args.agentId)
    .run();
}

export async function listTeamAgents(
  db: D1Database,
  teamId: string
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT agent_id FROM team_agents WHERE team_id = ? ORDER BY agent_id"
    )
    .bind(teamId)
    .all<{ agent_id: string }>();
  return results.map((r) => r.agent_id);
}

export async function setTeamApprover(
  db: D1Database,
  args: { teamId: string; memberId: string; on: boolean }
): Promise<void> {
  if (args.on) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO team_approvers (team_id, member_id) VALUES (?, ?)"
      )
      .bind(args.teamId, args.memberId)
      .run();
  } else {
    await db
      .prepare("DELETE FROM team_approvers WHERE team_id = ? AND member_id = ?")
      .bind(args.teamId, args.memberId)
      .run();
  }
}

export async function listTeamApprovers(
  db: D1Database,
  teamId: string
): Promise<OrgMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.* FROM org_members m
       JOIN team_approvers ta ON ta.member_id = m.id
       WHERE ta.team_id = ? ORDER BY m.email`
    )
    .bind(teamId)
    .all<OrgMemberRow>();
  return results;
}

/** Distinct agent ids known to the org (from minted keys), for team UI. */
export async function listKnownAgentIds(
  db: D1Database,
  orgId: string
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT DISTINCT agent_id FROM agent_keys WHERE org_id = ? ORDER BY agent_id"
    )
    .bind(orgId)
    .all<{ agent_id: string }>();
  return results.map((r) => r.agent_id);
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
          approval_ref, decided_at, decision_token, team_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      row.decision_token ?? null,
      row.team_id ?? null
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

export async function insertDecisionToken(
  db: D1Database,
  args: { token: string; orgId: string; requestId: string; recipientEmail: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO decision_tokens (token, org_id, request_id, recipient_email) VALUES (?, ?, ?, ?)"
    )
    .bind(args.token, args.orgId, args.requestId, args.recipientEmail)
    .run();
}

export async function getDecisionToken(
  db: D1Database,
  token: string
): Promise<{ org_id: string; request_id: string; recipient_email: string } | null> {
  return db
    .prepare(
      "SELECT org_id, request_id, recipient_email FROM decision_tokens WHERE token = ?"
    )
    .bind(token)
    .first();
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
    /** Team the approval reserved budget against; recorded so record_outcome
     * corrects the right counter even after the agent is reassigned. */
    teamId?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE purchase_requests
       SET status = ?, approver = ?, approval_ref = ?, denial_reason = ?,
           decided_at = ?, team_id = ?
       WHERE org_id = ? AND id = ? AND status = 'pending_approval'`
    )
    .bind(
      args.status,
      args.approver,
      args.approvalRef ?? null,
      args.denialReason ?? null,
      new Date().toISOString(),
      args.teamId ?? null,
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

export type LedgerEventRow = {
  seq: number;
  org_id: string;
  request_id: string;
  event_type: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  created_at: string;
};

export async function listLedgerEventsForRequest(
  db: D1Database,
  orgId: string,
  requestId: string
): Promise<LedgerEventRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM ledger_events WHERE org_id = ? AND request_id = ? ORDER BY seq ASC"
    )
    .bind(orgId, requestId)
    .all<LedgerEventRow>();
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
