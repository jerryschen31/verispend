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
  return { orgId };
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
