# Compliance reports (Phase 4)

A compliance report is a signed, audit-ready attestation that maps an org's
ledger evidence to the frameworks regulators and enterprise buyers care
about: **NIST AI RMF 1.0**, **ISO/IEC 42001 Annex A**, and **SOX-style
financial control objectives**. It is the take-away artifact for "prove your
AI spent correctly": a CFO hands it (plus the audit bundle) to an auditor,
and the auditor can verify every claim without trusting VeriSpend.

## Positioning: evidence, not certification

The report presents **machine-generated evidence relevant to controls**. It
never asserts that the org "complies" with NIST, ISO, or SOX — those
judgments belong to the org and its auditors. Concretely:

- Each mapped control resolves to `evidenced` (the ledger carries relevant
  evidence), `attention` (the evidence includes open findings — e.g. an
  unauthorized charge), or `no_activity` (nothing relevant in the period).
- The SOX mapping uses our own control-objective IDs (`AUTH-1`, `SOD-1`,
  `CM-1`, `ACCESS-1`, `REC-1`, `MON-1`, `TRAIL-1`) labeled "SOX-style";
  SOX compliance is an auditor's opinion about the customer, not a property
  a vendor can grant.
- Control mappings are **versioned data** (`src/compliance-map.ts`,
  `COMPLIANCE_MAP_VERSION`), so new frameworks and agentic profiles (e.g.
  NIST's AI Agent Standards Initiative) can be added without schema changes.
  Every report records the map version it was generated under.

## What a report contains

The signed payload (`payload_json`, verbatim bytes) carries:

- **Chain verification** — the org's full hash chain re-verified at
  generation time, plus a ledger anchor (first/last event in period and the
  chain head) tying the report into the tamper-evident chain.
- **Activity summary** — purchases by status, denials by rule, mandate
  verifications/rejections, bill reconciliation statuses, settlement match
  statuses, receipts issued, and event counts by type.
- **Control matrix** — every mapped control with its status and the
  resolved evidence behind it, including citable ledger proof points
  (event seq + hash).
- **Exceptions** — unauthorized charges, over-billed invoices, settlement
  amount mismatches, currently frozen agents, and the period's policy
  change log (version + editor, from the chain).

## The control-plane audit trail

Audit frameworks care about *change management* as much as transactions.
Phase 4 extended the ledger so every control-plane mutation is chained:

`org_created`, `agent_key_created`, `agent_key_revoked`, `member_upserted`,
`member_removed`, `issuer_registered`, `issuer_revoked`, `team_created`,
`team_agent_assigned`, `team_approver_changed`, `export_generated`, and
`report_generated`.

Exports and reports are data egress, so generating one is itself an event
on the chain (the export event lands *before* the artifact is built, so
every bundle includes the record of its own generation). Dashboard logins
are deliberately not ledgered — every consequential action is already
attributed to the member who performed it.

The audit bundle (v2) also embeds control-plane reference data — members,
agent-key lifecycle (ids only, never credential hashes), issuer registry,
teams — so an auditor reads the chain's events against the current state.

## Generating a report

**Dashboard** (session, `admin` role to generate; all roles can view):
Reports → pick an optional period → Generate. The report page is print-styled
— use the "Print / save as PDF" button for a paper artifact — and offers the
signed `report.json` download.

**Admin API** (works identically on dev and prod, guarded by `ADMIN_KEY`):

```sh
curl -X POST https://<host>/api/admin/orgs/<orgId>/reports \
  -H "content-type: application/json" -H "x-admin-key: $ADMIN_KEY" \
  -d '{"period_start":"2026-07-01","period_end":"2026-07-31"}' > report.json
# fetch a stored report later:
curl https://<host>/api/admin/orgs/<orgId>/reports/<reportId> \
  -H "x-admin-key: $ADMIN_KEY"
```

Periods are inclusive `YYYY-MM-DD` bounds; omit both to cover the full
history. Chain verification always covers the whole chain (a partial chain
cannot self-verify).

## Verifying a report (no VeriSpend code)

```sh
node scripts/verify-report.ts report.json [bundle.json]
```

This checks, from the recipe embedded in the report itself:

1. The Ed25519 signature over the exact `payload_json` bytes.
2. That `signature.key_id` is the thumbprint of the embedded public key —
   cross-check it against `GET /.well-known/verispend-keys.json`.
3. With a bundle: that the report's ledger anchors (first/last event and
   chain head) appear, unaltered, in the audit bundle's independently
   verified chain (`scripts/verify-bundle.ts`).

Any altered byte of the payload — say, whitewashing an exception — breaks
the signature.

## Demo runbook (dev and production)

1. **Seed** a demo org with every evidence type the report maps (runaway
   agent, over-billing, forged mandate, cross-rail settlements incl. an
   unauthorized charge, signed receipt, and the report itself):

   ```sh
   # dev
   npm run simulate -- --approver you@example.com
   # production
   npm run simulate -- --base-url https://app.duedly.app \
     --admin-key <prod ADMIN_KEY> --approver you@example.com
   ```

   Scenario 12 generates and offline-verifies a compliance report as part
   of the run.

2. **Show it live**: log into the dashboard as the approver email (seeded
   as an org admin), open **Reports**, generate a report, walk the control
   matrix and exceptions, print-preview, download `report.json`.

3. **Close the loop**: verify the download offline with
   `node scripts/verify-report.ts report.json bundle.json` (bundle from
   Export → audit-bundle.json).
