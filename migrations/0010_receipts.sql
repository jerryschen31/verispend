-- Verifiable receipts (Phase 3): signed artifacts proving a purchase was
-- authorized, by whom, under what limits, and how it matched reality.
-- receipt_json holds the complete self-verifying document verbatim —
-- re-stringifying would break the signature. Reissuance is allowed (a later
-- receipt can capture settlement data the first lacked); the newest wins.

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  request_id TEXT NOT NULL REFERENCES purchase_requests(id),
  key_id TEXT NOT NULL,               -- thumbprint of the signing key
  payload_hash TEXT NOT NULL,         -- sha256 of the signed payload_json
  receipt_json TEXT NOT NULL,
  issued_by TEXT NOT NULL,            -- member email | 'admin-api' | 'mcp:<agent_id>'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_receipts_org_request ON receipts(org_id, request_id);
