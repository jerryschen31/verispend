# PR #1 review — feat: Phase 1 — circuit breaker and metered-usage reconciliation

2026-07-15, mode: fix

(src/approvals.ts:103) The HTML email body interpolates agent-controlled strings
(agentId/signal/reason, plus orgName) without escaping. A malicious agent could
inject HTML into the alert email via vendor/category/etc. (which are included in
`reason`), potentially leading to HTML/script injection in some mail clients.

**fixed**
Added an `escapeHtml` helper in `src/approvals.ts` and applied it to every
agent-controlled field interpolated into an HTML email body: `agentId`,
`orgName`, `reason`, and `signal` in `sendBreakerAlertEmail`, plus the
equivalent `agent_id`/`vendor`/`category`/`justification` fields in
`sendApprovalEmail` (same vulnerability class, pre-existing in that function
but touched by this PR's diff, so fixed alongside it for consistency).
Plain-text email bodies were left unescaped since there's no markup to
inject there. Added `test/approvals-email.test.ts` asserting that
`<script>`/`<img onerror>` payloads in vendor, category, justification,
agent id, and breaker reason never reach the HTML body unescaped.
Commit f817075.

---

(src/approvals.ts:137) `sendReconciliationAlertEmail` hardcodes
`currency = "USD"`, but the system already supports a per-org policy
currency (`PolicyRules.currency`) and other emails format using the
request's currency. For non-USD orgs this will format billed/expected/
variance incorrectly in both the subject and body.

**fixed**
`sendReconciliationAlertEmail` now takes `currency` as a required argument
instead of hardcoding `"USD"`. `ingestBill()` in `src/reconcile.ts` passes
`policy?.rules.currency ?? "USD"` — reusing the policy it already fetches
earlier in the function, so no extra DB call. Added test coverage in
`test/approvals-email.test.ts` asserting a EUR-configured org's bill alert
formats amounts as `€150.00` (subject and body), not `$150.00`, alongside a
USD control case. Commit f817075.
