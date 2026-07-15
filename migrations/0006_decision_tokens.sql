-- One token per notified recipient: the click itself attributes the decision
-- to a specific member, keeping the no-login one-click approval UX.
-- purchase_requests.decision_token remains as a legacy fallback for
-- approvals already in flight when this deploys.
CREATE TABLE decision_tokens (
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  request_id TEXT NOT NULL REFERENCES purchase_requests(id),
  recipient_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_decision_tokens_request ON decision_tokens(request_id);
