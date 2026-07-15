-- Named humans with org-wide roles. Login matches org_members, not
-- orgs.approver_email (which is retained for backward compatibility).
CREATE TABLE org_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, email)
);
CREATE INDEX idx_members_email ON org_members(email);

-- Backward compat: every existing approver becomes an admin member.
INSERT INTO org_members (id, org_id, email, role, created_at)
SELECT 'mem_' || lower(hex(randomblob(16))), id, lower(trim(approver_email)), 'admin', created_at
FROM orgs
WHERE approver_email IS NOT NULL AND trim(approver_email) != '';
