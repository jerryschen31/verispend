import {
  getOrg,
  getPolicyByVersion,
  getPurchaseRequest,
  getRequestByDecisionToken,
  applyHumanDecision,
  type PurchaseRequestRow,
} from "./db";
import { resolveAgentLimits, resolveOrgLimits } from "./policy";

const fmt = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100
  );

export async function sendApprovalEmail(
  env: Env,
  args: {
    approverEmail: string;
    orgName: string;
    row: Pick<
      PurchaseRequestRow,
      "agent_id" | "vendor" | "amount_cents" | "currency" | "category" | "justification"
    >;
    decisionToken: string;
  }
): Promise<void> {
  const approveUrl = `${env.BASE_URL}/decide/${args.decisionToken}/approve`;
  const denyUrl = `${env.BASE_URL}/decide/${args.decisionToken}/deny`;
  const amount = fmt(args.row.amount_cents, args.row.currency);

  const text = [
    `Agent "${args.row.agent_id}" at ${args.orgName} wants to make a purchase that needs your approval.`,
    ``,
    `Vendor:        ${args.row.vendor}`,
    `Amount:        ${amount}`,
    `Category:      ${args.row.category}`,
    `Justification: ${args.row.justification}`,
    ``,
    `Approve: ${approveUrl}`,
    `Deny:    ${denyUrl}`,
  ].join("\n");

  const html = `
    <p>Agent <strong>${args.row.agent_id}</strong> at ${args.orgName} wants to make a purchase that needs your approval.</p>
    <table cellpadding="4">
      <tr><td><strong>Vendor</strong></td><td>${args.row.vendor}</td></tr>
      <tr><td><strong>Amount</strong></td><td>${amount}</td></tr>
      <tr><td><strong>Category</strong></td><td>${args.row.category}</td></tr>
      <tr><td><strong>Justification</strong></td><td>${args.row.justification}</td></tr>
    </table>
    <p>
      <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Approve</a>
      &nbsp;
      <a href="${denyUrl}" style="background:#dc2626;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Deny</a>
    </p>`;

  try {
    await env.EMAIL.send({
      to: args.approverEmail,
      from: { email: env.EMAIL_FROM, name: "VeriSpend Approvals" },
      subject: `Approval needed: ${args.row.agent_id} → ${args.row.vendor} (${amount})`,
      text,
      html,
    });
  } catch (error) {
    // Email is best-effort: the approval also sits in the dashboard queue.
    console.log(
      JSON.stringify({
        event: "approval_email_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

export type DecisionOutcome = {
  ok: boolean;
  title: string;
  detail: string;
};

export async function decideRequest(
  env: Env,
  decisionToken: string,
  action: "approve" | "deny"
): Promise<DecisionOutcome> {
  const row = await getRequestByDecisionToken(env.DB, decisionToken);
  if (!row) {
    return { ok: false, title: "Not found", detail: "This approval link is invalid." };
  }
  return decideRequestRow(env, row, action);
}

export async function decideRequestById(
  env: Env,
  orgId: string,
  requestId: string,
  action: "approve" | "deny"
): Promise<DecisionOutcome> {
  const row = await getPurchaseRequest(env.DB, orgId, requestId);
  if (!row) {
    return { ok: false, title: "Not found", detail: "No such request." };
  }
  return decideRequestRow(env, row, action);
}

async function decideRequestRow(
  env: Env,
  row: PurchaseRequestRow,
  action: "approve" | "deny"
): Promise<DecisionOutcome> {
  if (row.status !== "pending_approval") {
    return {
      ok: false,
      title: "Already decided",
      detail: `This request was already resolved: it is now "${row.status}".`,
    };
  }

  const org = await getOrg(env.DB, row.org_id);
  const approver = org?.approver_email ?? "approver";
  const coordinator = env.ORG.getByName(row.org_id);

  if (action === "deny") {
    await applyHumanDecision(env.DB, {
      orgId: row.org_id,
      requestId: row.id,
      status: "denied",
      approver,
      denialReason: "Denied by approver.",
    });
    await coordinator.appendEvent({
      orgId: row.org_id,
      requestId: row.id,
      eventType: "human_decision",
      payload: { decision: "denied", approver },
    });
    return {
      ok: true,
      title: "Denied",
      detail: `${row.agent_id} will be told not to buy from ${row.vendor}.`,
    };
  }

  // Approving: the budget was not reserved at request time (the purchase was
  // pending), so enforce it now against the policy version the request was
  // evaluated under.
  const policy = await getPolicyByVersion(env.DB, row.org_id, row.policy_version);
  const reserve = await coordinator.reserve({
    agentId: row.agent_id,
    amountCents: row.amount_cents,
    orgLimits: policy ? resolveOrgLimits(policy.rules) : undefined,
    agentLimits: policy ? resolveAgentLimits(policy.rules, row.agent_id) : undefined,
  });

  if (!reserve.ok) {
    const reason = `Approved by ${approver}, but the ${reserve.exceeded.replaceAll("_", " ")} budget no longer fits this purchase (${reserve.usedCents}¢ of ${reserve.limitCents}¢ used).`;
    await applyHumanDecision(env.DB, {
      orgId: row.org_id,
      requestId: row.id,
      status: "denied",
      approver,
      denialReason: reason,
    });
    await coordinator.appendEvent({
      orgId: row.org_id,
      requestId: row.id,
      eventType: "human_decision",
      payload: { decision: "denied", approver, reason, budget: reserve },
    });
    return { ok: true, title: "Budget exceeded", detail: reason };
  }

  const approvalRef = `apr_${crypto.randomUUID()}`;
  await applyHumanDecision(env.DB, {
    orgId: row.org_id,
    requestId: row.id,
    status: "approved",
    approver,
    approvalRef,
  });
  await coordinator.appendEvent({
    orgId: row.org_id,
    requestId: row.id,
    eventType: "human_decision",
    payload: { decision: "approved", approver, approvalRef },
  });
  return {
    ok: true,
    title: "Approved",
    detail: `${row.agent_id} may buy from ${row.vendor} for ${fmt(row.amount_cents, row.currency)}.`,
  };
}
