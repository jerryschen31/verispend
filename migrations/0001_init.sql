-- VeriSpend core schema: multi-tenant from day one.

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  approver_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys are per (org, agent). Only a SHA-256 hash is stored.
CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  agent_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE INDEX idx_agent_keys_org ON agent_keys(org_id);

-- Policies are versioned and immutable; the active policy is the highest version.
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  version INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  source_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, version)
);

-- Current state of each purchase request (queryable view of the world).
CREATE TABLE purchase_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  agent_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  category TEXT NOT NULL,
  justification TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'denied', 'pending_approval', 'completed', 'canceled')),
  policy_version INTEGER NOT NULL,
  rule_fired TEXT,
  denial_reason TEXT,
  approval_ref TEXT,
  approver TEXT,
  decided_at TEXT,
  outcome_amount_cents INTEGER,
  outcome_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pr_org_created ON purchase_requests(org_id, created_at);
CREATE INDEX idx_pr_org_status ON purchase_requests(org_id, status);

-- Append-only, hash-chained audit log. Never UPDATE or DELETE rows here.
-- Chain is per-org: each event's hash covers (prev_hash, org_id, request_id,
-- event_type, payload_json, created_at).
CREATE TABLE ledger_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ledger_org_seq ON ledger_events(org_id, seq);
