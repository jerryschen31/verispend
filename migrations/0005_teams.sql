-- Teams: named groups of agents sharing a budget, with designated approvers.
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, name)
);

-- One team per agent; agent_id is the string identity used by MCP auth, not
-- a key row (one agent may hold several keys).
CREATE TABLE team_agents (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, agent_id)
);
CREATE INDEX idx_team_agents_team ON team_agents(team_id);

-- Which members receive a team's approval emails (routing, not capability;
-- org-wide capability stays on org_members.role).
CREATE TABLE team_approvers (
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL REFERENCES org_members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, member_id)
);

-- Request-detail timeline and audit-bundle queries read a request's events.
CREATE INDEX idx_ledger_org_request ON ledger_events(org_id, request_id);
