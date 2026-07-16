-- The team a purchase's budget was reserved against, captured at reservation
-- time (request time for auto-approvals, approval time for escalations).
-- record_outcome corrects the counter on THIS team, not the agent's current
-- team, so reassigning an agent never misattributes an in-flight purchase.
ALTER TABLE purchase_requests ADD COLUMN team_id TEXT;
