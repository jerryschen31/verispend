// Compliance control mappings (Phase 4): which framework controls the
// ledger's evidence speaks to, expressed as data so new frameworks and
// profiles can be added without touching the report machinery.
//
// Positioning matters here: VeriSpend is an EVIDENCE PROVIDER, not a
// certifier. A control mapping means "the ledger carries machine-generated
// evidence relevant to this control", never "you comply with it" — that
// judgment belongs to the customer's auditor. Control titles are careful
// paraphrases, not verbatim standard text.

import type { LedgerEventType } from "./ledger";

/** Bump when controls are added/changed; recorded in every report. */
export const COMPLIANCE_MAP_VERSION = 1;

export const FRAMEWORKS = {
  "nist-ai-rmf": {
    name: "NIST AI Risk Management Framework 1.0",
    note: "Voluntary US framework; subcategory IDs per NIST AI 100-1.",
  },
  "iso-42001": {
    name: "ISO/IEC 42001 (AI management systems), Annex A",
    note: "Mapping based on the published Annex A control list.",
  },
  "sox-itgc": {
    name: "SOX-style financial controls (COSO-informed objectives)",
    note:
      "Control objectives commonly tested in ICFR audits, applied to " +
      "agent spending. Not a claim of SOX compliance.",
  },
} as const;

export type Framework = keyof typeof FRAMEWORKS;

/**
 * Declarative evidence checks, resolved against the ledger and policy at
 * report time (src/report.ts):
 * - chain_verified   → the org's hash chain re-verifies end to end
 * - event_present    → at least one of these event types in the period
 * - config_state     → the active policy enables this safeguard
 * - exception_scan   → period is clean of this exception (finding any
 *                      flags the control "attention", with counts)
 */
export type EvidenceQuery =
  | { kind: "chain_verified" }
  | { kind: "event_present"; eventTypes: LedgerEventType[]; label: string }
  | { kind: "config_state"; check: ConfigCheck; label: string }
  | { kind: "exception_scan"; scan: ExceptionScan; label: string };

export type ConfigCheck =
  | "policy_exists"
  | "transaction_cap_configured"
  | "escalation_configured"
  | "budgets_configured"
  | "breaker_enabled"
  | "vendor_rules_configured"
  | "mandates_required";

export type ExceptionScan =
  | "unauthorized_charges"
  | "overbilled_bills"
  | "settlement_amount_mismatches"
  | "unresolved_breaker_trips";

export type ControlMapping = {
  framework: Framework;
  controlId: string;
  title: string;
  /** What the ledger's evidence says about this control, in plain terms. */
  rationale: string;
  evidence: EvidenceQuery[];
};

const decisionEvents: LedgerEventType[] = ["auto_decision", "human_decision"];

export const CONTROL_MAPPINGS: ControlMapping[] = [
  // ---------- NIST AI RMF 1.0 ----------
  {
    framework: "nist-ai-rmf",
    controlId: "GOVERN 1.2",
    title: "AI risk policies are established, transparent, and maintained",
    rationale:
      "The org's spend policy is explicit, versioned, and immutable; every " +
      "edit is a new version attributed on the tamper-evident ledger.",
    evidence: [
      { kind: "config_state", check: "policy_exists", label: "active spend policy" },
      {
        kind: "event_present",
        eventTypes: ["policy_updated", "org_created"],
        label: "policy lifecycle events",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "GOVERN 2.1",
    title: "Roles and responsibilities for AI oversight are defined",
    rationale:
      "Member roles (admin/approver/viewer) gate who can change policy, " +
      "decide purchases, or manage credentials; every grant and change is " +
      "ledgered.",
    evidence: [
      {
        kind: "event_present",
        eventTypes: ["member_upserted", "member_removed", "org_created"],
        label: "membership and role events",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "GOVERN 3.2",
    title: "Human oversight of AI decisions is defined and exercised",
    rationale:
      "Purchases crossing policy thresholds route to named human approvers; " +
      "each human decision is ledgered with the decider and channel.",
    evidence: [
      { kind: "config_state", check: "escalation_configured", label: "escalation thresholds" },
      {
        kind: "event_present",
        eventTypes: ["approval_routed", "human_decision"],
        label: "human approval events",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "GOVERN 6.1",
    title: "Third-party AI risks are addressed by policy and procedure",
    rationale:
      "Vendor allow/deny rules constrain who agents may pay; mandate-issuer " +
      "trust roots are explicitly registered per org and revocable, with " +
      "both ledgered.",
    evidence: [
      { kind: "config_state", check: "vendor_rules_configured", label: "vendor rules" },
      {
        kind: "event_present",
        eventTypes: ["issuer_registered", "issuer_revoked"],
        label: "issuer trust-root events",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "MAP 3.3",
    title: "The AI system's scope of operation is specified and bounded",
    rationale:
      "Per-transaction caps, per-agent/team/org budgets, and (optionally) " +
      "network-issued mandate scopes bound what each agent may spend.",
    evidence: [
      { kind: "config_state", check: "transaction_cap_configured", label: "transaction cap" },
      { kind: "config_state", check: "budgets_configured", label: "budgets" },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "MEASURE 2.4",
    title: "Deployed AI system behavior is monitored in production",
    rationale:
      "Every purchase attempt is pattern-checked (loops, velocity, spend " +
      "acceleration) and metered usage is recorded against budgets " +
      "continuously.",
    evidence: [
      { kind: "config_state", check: "breaker_enabled", label: "circuit breaker" },
      {
        kind: "event_present",
        eventTypes: ["purchase_requested", "usage_recorded"],
        label: "monitored activity",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "MEASURE 3.1",
    title: "Mechanisms track emergent and unanticipated AI risks",
    rationale:
      "Cross-rail settlement matching surfaces charges no agent requested; " +
      "reconciliation surfaces billing that diverges from recorded usage.",
    evidence: [
      { kind: "exception_scan", scan: "unauthorized_charges", label: "unauthorized charges" },
      { kind: "exception_scan", scan: "settlement_amount_mismatches", label: "settlement mismatches" },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "MANAGE 2.4",
    title: "Mechanisms exist to disengage or deactivate the AI system",
    rationale:
      "A tripped circuit breaker freezes the agent (all spending denied) " +
      "until a human unfreezes it; agent credentials are individually " +
      "revocable. Trips, resets, and revocations are ledgered.",
    evidence: [
      { kind: "config_state", check: "breaker_enabled", label: "circuit breaker" },
      { kind: "exception_scan", scan: "unresolved_breaker_trips", label: "unresolved freezes" },
    ],
  },
  {
    framework: "nist-ai-rmf",
    controlId: "MANAGE 4.1",
    title: "Post-deployment monitoring and incident response are implemented",
    rationale:
      "Breaker trips, unauthorized charges, and reconciliation flags alert " +
      "named approvers in real time and land on the ledger as incidents " +
      "with their resolution trail.",
    evidence: [
      {
        kind: "event_present",
        eventTypes: ["breaker_tripped", "breaker_reset", "unauthorized_charge", "bill_reconciled"],
        label: "incident and monitoring events",
      },
    ],
  },

  // ---------- ISO/IEC 42001 Annex A ----------
  {
    framework: "iso-42001",
    controlId: "A.2.2",
    title: "An AI policy is documented and maintained",
    rationale:
      "The versioned spend policy is the documented rule set governing " +
      "agent spending; its full history ships in every audit bundle.",
    evidence: [
      { kind: "config_state", check: "policy_exists", label: "active spend policy" },
      { kind: "event_present", eventTypes: ["policy_updated", "org_created"], label: "policy lifecycle events" },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.3.2",
    title: "AI roles and responsibilities are defined and allocated",
    rationale:
      "Admin/approver/viewer roles allocate spending oversight duties; " +
      "team approver routing assigns responsibility per agent group.",
    evidence: [
      {
        kind: "event_present",
        eventTypes: ["member_upserted", "member_removed", "team_approver_changed", "org_created"],
        label: "role allocation events",
      },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.6.2.6",
    title: "AI system operation and monitoring",
    rationale:
      "Agents operate only through pre-authorization; runtime monitoring " +
      "(circuit breaker, budget counters, settlement matching) runs on " +
      "every transaction.",
    evidence: [
      { kind: "config_state", check: "breaker_enabled", label: "circuit breaker" },
      { kind: "event_present", eventTypes: decisionEvents, label: "pre-authorization decisions" },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.6.2.8",
    title: "AI system recording of event logs",
    rationale:
      "The append-only, hash-chained ledger is this control: every " +
      "request, decision, outcome, and config change is an event whose " +
      "integrity re-verifies on demand.",
    evidence: [
      { kind: "chain_verified" },
      { kind: "event_present", eventTypes: ["purchase_requested"], label: "recorded activity" },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.8.4",
    title: "Incidents are communicated to relevant interested parties",
    rationale:
      "Breaker trips, unauthorized charges, and over-billing alert the " +
      "org's approvers by email at detection time; the ledger records " +
      "what was detected and when.",
    evidence: [
      {
        kind: "event_present",
        eventTypes: ["breaker_tripped", "unauthorized_charge", "bill_reconciled"],
        label: "alerted incidents",
      },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.9.2",
    title: "Processes for responsible use of AI are defined",
    rationale:
      "No agent purchase proceeds without a policy evaluation; every " +
      "decision carries a full rule-by-rule trace explaining why it was " +
      "allowed or blocked.",
    evidence: [
      { kind: "event_present", eventTypes: decisionEvents, label: "explained decisions" },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.9.4",
    title: "Use of the AI system stays within its intended purpose",
    rationale:
      "Agents state vendor, category, and justification per purchase; " +
      "category/vendor rules and (optionally) mandate scopes enforce the " +
      "intended purpose, and reconciliation checks reality against it.",
    evidence: [
      { kind: "event_present", eventTypes: ["purchase_requested"], label: "stated intent" },
      { kind: "exception_scan", scan: "settlement_amount_mismatches", label: "intent vs. settlement" },
    ],
  },
  {
    framework: "iso-42001",
    controlId: "A.10.3",
    title: "Supplier (third-party) risks are managed",
    rationale:
      "Provider bills reconcile against recorded usage; settlement records " +
      "from any rail match against authorizations; vendor rules and issuer " +
      "registration gate which third parties are trusted.",
    evidence: [
      { kind: "exception_scan", scan: "overbilled_bills", label: "over-billing" },
      { kind: "event_present", eventTypes: ["bill_ingested", "settlement_ingested"], label: "third-party records" },
    ],
  },

  // ---------- SOX-style ICFR / ITGC objectives ----------
  {
    framework: "sox-itgc",
    controlId: "AUTH-1",
    title: "Transactions are authorized before execution",
    rationale:
      "Every agent purchase is checked against policy before money moves; " +
      "the decision (and the rule that fired) is recorded per transaction.",
    evidence: [
      { kind: "event_present", eventTypes: decisionEvents, label: "pre-authorization decisions" },
      { kind: "config_state", check: "transaction_cap_configured", label: "authorization limits" },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "SOD-1",
    title: "Duties are segregated between execution and approval",
    rationale:
      "Agents (machine identities) can only request; humans with the " +
      "approver/admin role decide escalations; policy and credential " +
      "changes require the admin role. Identity comes from credentials, " +
      "not self-reported arguments.",
    evidence: [
      { kind: "config_state", check: "escalation_configured", label: "human approval thresholds" },
      { kind: "event_present", eventTypes: ["human_decision"], label: "human decisions" },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "CM-1",
    title: "Changes to controls are managed and attributed",
    rationale:
      "Policy edits create immutable new versions attributed to the " +
      "editor on the chain; past decisions keep the version they were " +
      "evaluated under.",
    evidence: [
      { kind: "event_present", eventTypes: ["policy_updated", "org_created"], label: "attributed policy changes" },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "ACCESS-1",
    title: "Access is provisioned, changed, and revoked with an audit trail",
    rationale:
      "Agent credential issuance/revocation and member add/role-change/" +
      "removal are all ledgered with actor attribution.",
    evidence: [
      {
        kind: "event_present",
        eventTypes: [
          "agent_key_created",
          "agent_key_revoked",
          "member_upserted",
          "member_removed",
          "org_created",
        ],
        label: "access lifecycle events",
      },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "REC-1",
    title: "Records are complete, accurate, and reconciled",
    rationale:
      "Intent, authorization, outcome, and settlement are matched per " +
      "purchase across every rail; usage-based bills reconcile against " +
      "recorded consumption, with variances flagged.",
    evidence: [
      { kind: "exception_scan", scan: "overbilled_bills", label: "billing variances" },
      { kind: "exception_scan", scan: "settlement_amount_mismatches", label: "settlement variances" },
      { kind: "exception_scan", scan: "unauthorized_charges", label: "unauthorized charges" },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "MON-1",
    title: "Anomalies are detected, escalated, and resolved",
    rationale:
      "The circuit breaker halts runaway spending automatically; " +
      "unfreezing is an attributed human action; unauthorized charges " +
      "alert approvers when detected.",
    evidence: [
      { kind: "config_state", check: "breaker_enabled", label: "automated halting" },
      { kind: "exception_scan", scan: "unresolved_breaker_trips", label: "unresolved freezes" },
    ],
  },
  {
    framework: "sox-itgc",
    controlId: "TRAIL-1",
    title: "The audit trail is tamper-evident and its egress accountable",
    rationale:
      "Ledger events are hash-chained (any alteration is detectable and " +
      "locatable); exports and reports of the record are themselves " +
      "recorded on the chain.",
    evidence: [
      { kind: "chain_verified" },
      { kind: "event_present", eventTypes: ["export_generated", "report_generated"], label: "recorded egress" },
    ],
  },
];
