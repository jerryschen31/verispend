-- Compliance reports (Phase 4): signed, audit-ready attestations mapping
-- the org's ledger evidence to framework controls (NIST AI RMF, ISO/IEC
-- 42001, SOX-style objectives). report_json holds the complete
-- self-verifying document verbatim — re-stringifying would break the
-- signature. Reports are point-in-time artifacts; regenerating for the
-- same period creates a new row rather than replacing history.

CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  period_start TEXT,                  -- inclusive YYYY-MM-DD; NULL = from genesis
  period_end TEXT,                    -- inclusive YYYY-MM-DD; NULL = through now
  key_id TEXT NOT NULL,               -- thumbprint of the signing key
  payload_hash TEXT NOT NULL,         -- sha256 of the signed payload_json
  report_json TEXT NOT NULL,
  issued_by TEXT NOT NULL,            -- member email | 'admin-api'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_compliance_reports_org ON compliance_reports(org_id, created_at);
