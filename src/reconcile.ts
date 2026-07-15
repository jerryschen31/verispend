// Metered-bill reconciliation: match what agents reported consuming against
// what the provider billed. Reconciliation runs once, at bill ingest, and the
// verdict is stored on the bill row and the ledger.

import { sendReconciliationAlertEmail } from "./approvals";
import {
  getActivePolicy,
  getOrg,
  insertBilledCharge,
  sumExpectedCost,
  type BilledChargeRow,
} from "./db";
import type { ReconciliationRules } from "./policy";

export type ReconStatus = "ok" | "overbilled" | "underbilled" | "no_usage_data";

export const RECON_DEFAULTS: Required<ReconciliationRules> = {
  toleranceCents: 1_00,
  tolerancePercent: 2,
};

export function resolveReconciliationRules(
  rules: ReconciliationRules | undefined
): Required<ReconciliationRules> {
  return {
    toleranceCents: rules?.toleranceCents ?? RECON_DEFAULTS.toleranceCents,
    tolerancePercent: rules?.tolerancePercent ?? RECON_DEFAULTS.tolerancePercent,
  };
}

export function classifyVariance(args: {
  expectedCents: number;
  billedCents: number;
  tolerance: Required<ReconciliationRules>;
}): { status: ReconStatus; varianceCents: number } {
  const varianceCents = args.billedCents - args.expectedCents;
  if (args.expectedCents === 0 && args.billedCents > 0) {
    return { status: "no_usage_data", varianceCents };
  }
  const allowed = Math.max(
    args.tolerance.toleranceCents,
    (args.tolerance.tolerancePercent / 100) * args.expectedCents
  );
  if (Math.abs(varianceCents) <= allowed) {
    return { status: "ok", varianceCents };
  }
  return {
    status: varianceCents > 0 ? "overbilled" : "underbilled",
    varianceCents,
  };
}

export type IngestBillArgs = {
  orgId: string;
  vendor: string;
  periodStart: string; // YYYY-MM-DD, inclusive
  periodEnd: string; // YYYY-MM-DD, inclusive
  amountCents: number;
  memo?: string;
  enteredBy: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type IngestBillResult =
  | { ok: true; bill: Omit<BilledChargeRow, "created_at"> }
  | { ok: false; error: string };

/** Validate, reconcile against recorded usage, persist, and put it on the ledger. */
export async function ingestBill(
  env: Env,
  args: IngestBillArgs
): Promise<IngestBillResult> {
  if (!args.vendor.trim()) return { ok: false, error: "vendor is required" };
  if (!DATE_RE.test(args.periodStart) || !DATE_RE.test(args.periodEnd)) {
    return { ok: false, error: "period_start and period_end must be YYYY-MM-DD" };
  }
  if (args.periodStart > args.periodEnd) {
    return { ok: false, error: "period_start must not be after period_end" };
  }
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    return { ok: false, error: "amount_cents must be a positive integer" };
  }

  const policy = await getActivePolicy(env.DB, args.orgId);
  const tolerance = resolveReconciliationRules(policy?.rules.reconciliation);
  const expectedCents = await sumExpectedCost(env.DB, {
    orgId: args.orgId,
    vendor: args.vendor,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
  });
  const { status, varianceCents } = classifyVariance({
    expectedCents,
    billedCents: args.amountCents,
    tolerance,
  });

  const bill: Omit<BilledChargeRow, "created_at"> = {
    id: `bill_${crypto.randomUUID()}`,
    org_id: args.orgId,
    vendor: args.vendor,
    period_start: args.periodStart,
    period_end: args.periodEnd,
    amount_cents: args.amountCents,
    memo: args.memo ?? null,
    expected_cents: expectedCents,
    variance_cents: varianceCents,
    recon_status: status,
  };
  await insertBilledCharge(env.DB, bill);

  const coordinator = env.ORG.getByName(args.orgId);
  await coordinator.appendEvent({
    orgId: args.orgId,
    requestId: bill.id,
    eventType: "bill_ingested",
    payload: {
      vendor: args.vendor,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      amountCents: args.amountCents,
      memo: args.memo ?? null,
      enteredBy: args.enteredBy,
    },
  });
  await coordinator.appendEvent({
    orgId: args.orgId,
    requestId: bill.id,
    eventType: "bill_reconciled",
    payload: { expectedCents, varianceCents, status, tolerance },
  });

  if (status !== "ok") {
    const org = await getOrg(env.DB, args.orgId);
    if (org?.approver_email) {
      await sendReconciliationAlertEmail(env, {
        approverEmail: org.approver_email,
        orgName: org.name,
        vendor: args.vendor,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        billedCents: args.amountCents,
        expectedCents,
        status,
        currency: policy?.rules.currency ?? "USD",
      });
    }
  }

  return { ok: true, bill };
}
