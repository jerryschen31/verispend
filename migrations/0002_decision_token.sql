-- Secret token authorizing a human approve/deny decision on a pending request.
ALTER TABLE purchase_requests ADD COLUMN decision_token TEXT;
CREATE UNIQUE INDEX idx_pr_decision_token ON purchase_requests(decision_token)
  WHERE decision_token IS NOT NULL;
