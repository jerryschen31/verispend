-- Cross-rail settlement confirmations (Phase 3): after-the-fact records of
-- what was actually charged, pushed or uploaded to VeriSpend from any rail
-- (card record, stablecoin transaction, checkout receipt, Stripe event).
-- VeriSpend never pulls these from a payment platform. Each settlement is
-- matched to a purchase request at ingest; a charge no agent ever requested
-- is flagged as unauthorized.

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  rail TEXT NOT NULL CHECK (rail IN ('card', 'stablecoin', 'checkout', 'stripe_event', 'other')),
  settlement_ref TEXT NOT NULL,       -- the rail's own id: auth code, tx hash, order id, ch_...
  vendor TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at TEXT NOT NULL,          -- ISO timestamp reported by the rail
  raw_json TEXT NOT NULL,             -- original payload verbatim (evidence)
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'amount_mismatch', 'unauthorized')),
  match_method TEXT NOT NULL CHECK (match_method IN ('settlement_ref', 'approval_ref', 'heuristic', 'none')),
  matched_request_id TEXT,
  variance_cents INTEGER NOT NULL DEFAULT 0,  -- settled - (outcome ?? approved) amount
  entered_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, rail, settlement_ref)       -- re-ingesting the same record is idempotent
);
CREATE INDEX idx_settlements_org_created ON settlements(org_id, created_at);
CREATE INDEX idx_settlements_org_request ON settlements(org_id, matched_request_id);

-- Structured settlement identifiers the agent reports at record_outcome time,
-- enabling exact cross-rail matching instead of the free-text receipt field.
ALTER TABLE purchase_requests ADD COLUMN settlement_rail TEXT;
ALTER TABLE purchase_requests ADD COLUMN settlement_ref TEXT;
