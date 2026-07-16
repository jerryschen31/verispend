# PR #2 review — Phase 2: team controls, explainable decisions, audit export

2026-07-16, mode: fix

Copilot reviewed 23/25 files and produced one inline comment plus one
low-confidence suppressed note.

---

(src/mcp.ts) `record_outcome` adjusted team budget counters using the agent's
*current* team membership. If an agent was reassigned between its purchase
being approved (budget reserved on team A) and its outcome being recorded, the
delta was applied to team B — both corrupting team B's shared counter (which
never held the reservation) and leaving team A's counter uncorrected. This
directly contradicts the UI promise that already-counted spend stays with the
team it was reserved against.

**fixed** (7554b42)
The team a purchase's budget is reserved against is now pinned onto the
purchase request at reservation time — request time for auto-approvals
(`insertPurchaseRequest`), approval time for escalations (`applyHumanDecision`)
— via a new nullable `purchase_requests.team_id` column (migration
`0007_request_team.sql`). `record_outcome` reads that stored `team_id` and
corrects the counter on the reservation's team, never re-resolving the agent's
current team. Added `test/teams.test.ts` › "corrects an outcome on the
reservation's team after the agent is reassigned": reserves $20 on team alpha,
reassigns the agent to team beta, records a $15 outcome, and asserts alpha's
shared counter reads $15 while beta's stays $0.

---

(src/index.ts:76, suppressed / low-confidence) The admin org-provisioning
endpoint can create an org with no seeded admin/approver (no `approver_email`,
`members` omitted or all viewers), leaving nobody able to log in or receive
escalation approvals.

**status: not changed (reasoned decline)**
This was a suppressed low-confidence note, not a posted inline comment, so
there is no comment thread to reply to. Declining deliberately: org
provisioning is intentionally a two-step, `ADMIN_KEY`-guarded flow (create the
org, then add members/keys via the admin API), and an agent-only org that uses
only the MCP surface and never the dashboard is a legitimate configuration
that several tests and the simulator's no-`--approver` mode rely on. A
member-less org is fully recoverable — members can be added at any time via
`POST /api/admin/orgs/:orgId/members` — so it is a recoverable footgun, not a
dead end. Enforcing "must seed an admin" at creation would break those valid
flows for a guard the admin caller can satisfy themselves. Worth revisiting as
a dashboard-side warning rather than a hard API constraint.

---

Verification: `npm run check` clean; `npm test` 119/119 pass (was 118, +1 for
the reassignment test). Migration `0007` applied locally.
