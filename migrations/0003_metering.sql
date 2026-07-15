-- Metered-usage reconciliation: what agents say they consumed (usage_records)
-- vs what providers actually billed (billed_charges). Reconciliation runs at
-- bill ingest and its result is stored on the bill row.

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  agent_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  metric TEXT NOT NULL,               -- e.g. "input_tokens", "api_calls", "gpu_hours"
  units REAL NOT NULL,
  expected_cost_cents INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_org_vendor_created ON usage_records(org_id, vendor, created_at);

CREATE TABLE billed_charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  vendor TEXT NOT NULL,
  period_start TEXT NOT NULL,         -- inclusive date YYYY-MM-DD
  period_end TEXT NOT NULL,           -- inclusive date YYYY-MM-DD
  amount_cents INTEGER NOT NULL,
  memo TEXT,
  expected_cents INTEGER NOT NULL,
  variance_cents INTEGER NOT NULL,    -- amount - expected
  recon_status TEXT NOT NULL CHECK (recon_status IN ('ok', 'overbilled', 'underbilled', 'no_usage_data')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bills_org_created ON billed_charges(org_id, created_at);
