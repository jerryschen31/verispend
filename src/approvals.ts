import {
  getOrg,
  getPolicyByVersion,
  getPurchaseRequest,
  getRequestByDecisionToken,
  getTeamForAgent,
  applyHumanDecision,
  type PurchaseRequestRow,
} from "./db";
import {
  resolveAgentLimits,
  resolveOrgLimits,
  resolveTeamLimits,
} from "./policy";

const fmt = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100
  );

// Purchase fields (vendor, category, justification, agent id, breaker
// reasons that quote them back) are agent-controlled and end up inside HTML
// email bodies. Escape before interpolating so a malicious agent can't
// inject markup into an approver's inbox.
const ESCAPE_HTML_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPE_HTML_MAP[c]);

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
    <p>Agent <strong>${escapeHtml(args.row.agent_id)}</strong> at ${escapeHtml(args.orgName)} wants to make a purchase that needs your approval.</p>
    <table cellpadding="4">
      <tr><td><strong>Vendor</strong></td><td>${escapeHtml(args.row.vendor)}</td></tr>
      <tr><td><strong>Amount</strong></td><td>${amount}</td></tr>
      <tr><td><strong>Category</strong></td><td>${escapeHtml(args.row.category)}</td></tr>
      <tr><td><strong>Justification</strong></td><td>${escapeHtml(args.row.justification)}</td></tr>
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

export async function sendBreakerAlertEmail(
  env: Env,
  args: {
    approverEmail: string;
    orgName: string;
    agentId: string;
    signal: string;
    reason: string;
  }
): Promise<void> {
  const dashboardUrl = `${env.BASE_URL}/dashboard/keys`;
  const text = [
    `VeriSpend froze agent "${args.agentId}" at ${args.orgName}.`,
    ``,
    `Signal: ${args.signal.replaceAll("_", " ")}`,
    `Reason: ${args.reason}`,
    ``,
    `All further purchases by this agent are denied until you unfreeze it:`,
    dashboardUrl,
  ].join("\n");

  const html = `
    <p>VeriSpend froze agent <strong>${escapeHtml(args.agentId)}</strong> at ${escapeHtml(args.orgName)}.</p>
    <p><strong>Signal:</strong> ${escapeHtml(args.signal.replaceAll("_", " "))}<br>
       <strong>Reason:</strong> ${escapeHtml(args.reason)}</p>
    <p>All further purchases by this agent are denied until you unfreeze it.</p>
    <p><a href="${dashboardUrl}" style="background:#dc2626;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review in dashboard</a></p>`;

  try {
    await env.EMAIL.send({
      to: args.approverEmail,
      from: { email: env.EMAIL_FROM, name: "VeriSpend Alerts" },
      subject: `Circuit breaker: agent ${args.agentId} frozen (${args.signal.replaceAll("_", " ")})`,
      text,
      html,
    });
  } catch (error) {
    // Alerts are best-effort: the freeze itself is already enforced.
    console.log(
      JSON.stringify({
        event: "breaker_alert_email_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

export async function sendReconciliationAlertEmail(
  env: Env,
  args: {
    approverEmail: string;
    orgName: string;
    vendor: string;
    periodStart: string;
    periodEnd: string;
    billedCents: number;
    expectedCents: number;
    status: string;
    currency: string;
  }
): Promise<void> {
  const currency = args.currency;
  const variance = args.billedCents - args.expectedCents;
  const text = [
    `A ${args.vendor} bill at ${args.orgName} does not match recorded agent usage.`,
    ``,
    `Period:   ${args.periodStart} → ${args.periodEnd}`,
    `Billed:   ${fmt(args.billedCents, currency)}`,
    `Expected: ${fmt(args.expectedCents, currency)} (from agent usage records)`,
    `Variance: ${fmt(variance, currency)} (${args.status.replaceAll("_", " ")})`,
    ``,
    `Review: ${env.BASE_URL}/dashboard/reconciliation`,
  ].join("\n");

  try {
    await env.EMAIL.send({
      to: args.approverEmail,
      from: { email: env.EMAIL_FROM, name: "VeriSpend Alerts" },
      subject: `Reconciliation flag: ${args.vendor} billed ${fmt(args.billedCents, currency)}, expected ${fmt(args.expectedCents, currency)}`,
      text,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "reconciliation_alert_email_failed",
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
  const team = await getTeamForAgent(env.DB, row.org_id, row.agent_id);
  const reserve = await coordinator.reserve({
    agentId: row.agent_id,
    amountCents: row.amount_cents,
    orgLimits: policy ? resolveOrgLimits(policy.rules) : undefined,
    agentLimits: policy ? resolveAgentLimits(policy.rules, row.agent_id) : undefined,
    teamId: team?.id,
    teamLimits: policy ? resolveTeamLimits(policy.rules, team?.id) : undefined,
  });

  if (!reserve.ok) {
    const scopeName =
      reserve.scope === "team"
        ? `team "${team?.name ?? "unknown"}" ${reserve.period}`
        : `${reserve.scope} ${reserve.period}`;
    const reason = `Approved by ${approver}, but the ${scopeName} budget no longer fits this purchase (${reserve.usedCents}¢ of ${reserve.limitCents}¢ used).`;
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
