import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  getActivePolicy,
  getOrg,
  getPurchaseRequest,
  insertPurchaseRequest,
  insertUsageRecord,
  markOutcomeRecorded,
} from "./db";
import { sendApprovalEmail, sendBreakerAlertEmail } from "./approvals";
import {
  evaluatePolicy,
  resolveAgentLimits,
  resolveBreakerRules,
  resolveOrgLimits,
  type PurchaseIntent,
  type StaticDecision,
} from "./policy";

// Set by the auth layer in index.ts before the request reaches the agent.
export type Props = {
  orgId: string;
  agentId: string;
};

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const jsonError = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

export class VeriSpendMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "VeriSpend",
    version: "0.1.0",
  });

  async init() {
    if (!this.props) {
      throw new Error("VeriSpendMCP requires authenticated props (orgId, agentId)");
    }
    const db = this.env.DB;
    const { orgId, agentId } = this.props;
    const org = () => this.env.ORG.getByName(orgId);

    this.server.registerTool(
      "request_purchase",
      {
        description:
          "Request authorization for a purchase BEFORE paying. Returns 'approved' " +
          "(with an approval_ref to cite), 'denied' (with the reason), or " +
          "'pending_approval' (a human was asked — poll check_approval). " +
          "Every request is recorded in the org's audit ledger.",
        inputSchema: {
          vendor: z.string().min(1).describe("Merchant or vendor name"),
          amount_cents: z
            .number()
            .int()
            .positive()
            .describe("Purchase amount in cents (e.g. $12.50 → 1250)"),
          currency: z
            .string()
            .default("USD")
            .describe("ISO 4217 currency code"),
          category: z
            .string()
            .min(1)
            .describe(
              "Spend category, e.g. software, travel, advertising, data"
            ),
          justification: z
            .string()
            .min(1)
            .describe("Why this purchase serves the task you were given"),
        },
      },
      async ({ vendor, amount_cents, currency, category, justification }) => {
        const policy = await getActivePolicy(db, orgId);
        if (!policy) {
          return jsonError("No spend policy configured for this org.");
        }

        const intent: PurchaseIntent = {
          agentId,
          vendor,
          amountCents: amount_cents,
          currency,
          category,
          justification,
        };

        // Circuit breaker first: it sees every request (even ones policy
        // would deny) and short-circuits everything once the agent is frozen.
        const breaker = await org().recordAndCheck({
          agentId,
          vendor,
          amountCents: amount_cents,
          category,
          breakerRules: resolveBreakerRules(policy.rules),
        });

        let decision: StaticDecision;
        if (breaker.status === "frozen") {
          decision = {
            decision: "denied",
            ruleFired: "agent_frozen",
            reason:
              `This agent is frozen by the circuit breaker (since ${breaker.frozenAt}): ` +
              `${breaker.reason} A human must unfreeze it in the VeriSpend dashboard.`,
          };
        } else if (breaker.status === "tripped") {
          decision = {
            decision: "denied",
            ruleFired: "circuit_breaker",
            reason: `Circuit breaker tripped (${breaker.signal.replaceAll("_", " ")}): ${breaker.reason}`,
          };
        } else {
          decision = evaluatePolicy(policy.rules, intent);
        }
        if (decision.decision === "approved") {
          const reserve = await org().reserve({
            agentId,
            amountCents: amount_cents,
            orgLimits: resolveOrgLimits(policy.rules),
            agentLimits: resolveAgentLimits(policy.rules, agentId),
          });
          if (!reserve.ok) {
            decision = {
              decision: "denied",
              ruleFired: `budget_${reserve.exceeded}`,
              reason:
                `Budget exceeded (${reserve.exceeded.replaceAll("_", " ")}): ` +
                `${reserve.usedCents}¢ of ${reserve.limitCents}¢ already used; ` +
                `this purchase of ${amount_cents}¢ does not fit.`,
            };
          }
        }

        const requestId = `pr_${crypto.randomUUID()}`;
        const approvalRef =
          decision.decision === "approved" ? `apr_${crypto.randomUUID()}` : null;
        const decidedNow = decision.decision !== "pending_approval";
        const decisionToken = decidedNow ? null : `dt_${crypto.randomUUID()}`;

        await insertPurchaseRequest(db, {
          id: requestId,
          org_id: orgId,
          agent_id: agentId,
          vendor,
          amount_cents,
          currency,
          category,
          justification,
          status: decision.decision,
          policy_version: policy.version,
          rule_fired: decision.ruleFired,
          denial_reason: decision.decision === "denied" ? decision.reason : null,
          approval_ref: approvalRef,
          decided_at: decidedNow ? new Date().toISOString() : null,
          decision_token: decisionToken,
        });

        if (decisionToken) {
          const orgRow = await getOrg(db, orgId);
          if (orgRow?.approver_email) {
            await sendApprovalEmail(this.env, {
              approverEmail: orgRow.approver_email,
              orgName: orgRow.name,
              row: {
                agent_id: agentId,
                vendor,
                amount_cents,
                currency,
                category,
                justification,
              },
              decisionToken,
            });
          }
        }

        await org().appendEvent({
          orgId,
          requestId,
          eventType: "purchase_requested",
          payload: { ...intent },
        });
        await org().appendEvent({
          orgId,
          requestId,
          eventType: "auto_decision",
          payload: {
            decision: decision.decision,
            ruleFired: decision.ruleFired,
            reason: "reason" in decision ? decision.reason : null,
            policyVersion: policy.version,
            approvalRef,
          },
        });

        if (breaker.status === "tripped") {
          await org().appendEvent({
            orgId,
            requestId,
            eventType: "breaker_tripped",
            payload: {
              agentId,
              signal: breaker.signal,
              reason: breaker.reason,
              config: resolveBreakerRules(policy.rules),
            },
          });
          const orgRow = await getOrg(db, orgId);
          if (orgRow?.approver_email) {
            await sendBreakerAlertEmail(this.env, {
              approverEmail: orgRow.approver_email,
              orgName: orgRow.name,
              agentId,
              signal: breaker.signal,
              reason: breaker.reason,
            });
          }
        }

        return json({
          request_id: requestId,
          status: decision.decision,
          rule_fired: decision.ruleFired,
          reason: "reason" in decision ? decision.reason : undefined,
          approval_ref: approvalRef ?? undefined,
          next_step:
            decision.decision === "approved"
              ? "Proceed with the purchase, then call record_outcome with the final amount."
              : decision.decision === "pending_approval"
                ? "Queued for human review in the VeriSpend dashboard. Poll check_approval with this request_id."
                : "Do not make this purchase.",
        });
      }
    );

    this.server.registerTool(
      "check_approval",
      {
        description:
          "Check the status of a purchase request that was pending human approval.",
        inputSchema: {
          request_id: z.string().describe("The request_id from request_purchase"),
        },
      },
      async ({ request_id }) => {
        const row = await getPurchaseRequest(db, orgId, request_id);
        if (!row) return jsonError(`No request ${request_id} for this org.`);
        return json({
          request_id,
          status: row.status,
          rule_fired: row.rule_fired,
          reason: row.denial_reason ?? undefined,
          approval_ref: row.approval_ref ?? undefined,
          approver: row.approver ?? undefined,
          next_step:
            row.status === "approved"
              ? "Proceed with the purchase, then call record_outcome with the final amount."
              : row.status === "pending_approval"
                ? "Still waiting on a human. Poll again later."
                : "Do not make this purchase.",
        });
      }
    );

    this.server.registerTool(
      "record_outcome",
      {
        description:
          "Report the final result AFTER completing an approved purchase. This closes " +
          "the audit loop: the final charge is recorded against the approval and " +
          "budget counters are corrected if the final amount differed.",
        inputSchema: {
          request_id: z.string().describe("The approved request_id"),
          final_amount_cents: z
            .number()
            .int()
            .positive()
            .describe("The amount actually charged, in cents"),
          receipt: z
            .string()
            .optional()
            .describe(
              "Optional receipt details: order id, confirmation number, line items"
            ),
        },
      },
      async ({ request_id, final_amount_cents, receipt }) => {
        const row = await getPurchaseRequest(db, orgId, request_id);
        if (!row) return jsonError(`No request ${request_id} for this org.`);
        if (row.status !== "approved") {
          return jsonError(
            `Request ${request_id} is '${row.status}', not 'approved' — nothing to record.`
          );
        }

        const deltaCents = final_amount_cents - row.amount_cents;
        if (deltaCents !== 0) {
          await org().adjust({ agentId: row.agent_id, deltaCents });
        }

        const outcomeJson = receipt ? JSON.stringify({ receipt }) : null;
        await markOutcomeRecorded(db, {
          orgId,
          requestId: request_id,
          outcomeAmountCents: final_amount_cents,
          outcomeJson,
        });
        await org().appendEvent({
          orgId,
          requestId: request_id,
          eventType: "outcome_recorded",
          payload: {
            approvedAmountCents: row.amount_cents,
            finalAmountCents: final_amount_cents,
            deltaCents,
            receipt: receipt ?? null,
          },
        });

        return json({
          request_id,
          status: "completed",
          final_amount_cents,
          variance_from_approval_cents: deltaCents,
        });
      }
    );

    this.server.registerTool(
      "record_usage",
      {
        description:
          "Report metered consumption AFTER using a pay-per-use service (API " +
          "tokens, compute, per-request fees). Call this after each batch of " +
          "usage — e.g. once per task or every N calls. The expected cost " +
          "counts against your budgets, and VeriSpend later reconciles the " +
          "provider's actual bill against these records to catch over-charges.",
        inputSchema: {
          vendor: z.string().min(1).describe("Provider being consumed, e.g. OpenAI"),
          metric: z
            .string()
            .min(1)
            .describe("What was consumed, e.g. input_tokens, api_calls, gpu_hours"),
          units: z.number().positive().describe("How many units were consumed"),
          expected_cost_cents: z
            .number()
            .int()
            .nonnegative()
            .describe("Expected cost of this usage in cents, at the agreed pricing"),
          note: z
            .string()
            .optional()
            .describe("Optional context: task, model, pricing tier"),
        },
      },
      async ({ vendor, metric, units, expected_cost_cents, note }) => {
        const policy = await getActivePolicy(db, orgId);
        if (!policy) return jsonError("No spend policy configured for this org.");

        const usageId = `ur_${crypto.randomUUID()}`;
        await insertUsageRecord(db, {
          id: usageId,
          org_id: orgId,
          agent_id: agentId,
          vendor,
          metric,
          units,
          expected_cost_cents,
          note: note ?? null,
        });

        // Usage already happened, so it can't be blocked — but it consumes
        // budget headroom so future purchases and dashboards see it.
        if (expected_cost_cents > 0) {
          await org().adjust({ agentId, deltaCents: expected_cost_cents });
        }
        await org().appendEvent({
          orgId,
          requestId: usageId,
          eventType: "usage_recorded",
          payload: { agentId, vendor, metric, units, expectedCostCents: expected_cost_cents, note: note ?? null },
        });

        const usage = await org().usage({ agentId });
        const agentLimits = resolveAgentLimits(policy.rules, agentId);
        const orgLimits = resolveOrgLimits(policy.rules);
        const overruns = [
          agentLimits?.dailyCents !== undefined &&
            usage.agentDailyCents > agentLimits.dailyCents &&
            "agent daily budget exceeded",
          agentLimits?.monthlyCents !== undefined &&
            usage.agentMonthlyCents > agentLimits.monthlyCents &&
            "agent monthly budget exceeded",
          orgLimits?.dailyCents !== undefined &&
            usage.orgDailyCents > orgLimits.dailyCents &&
            "org daily budget exceeded",
          orgLimits?.monthlyCents !== undefined &&
            usage.orgMonthlyCents > orgLimits.monthlyCents &&
            "org monthly budget exceeded",
        ].filter((w): w is string => typeof w === "string");

        return json({
          usage_id: usageId,
          recorded: { vendor, metric, units, expected_cost_cents },
          agent_daily_used_cents: usage.agentDailyCents,
          agent_daily_limit_cents: agentLimits?.dailyCents ?? null,
          warning:
            overruns.length > 0
              ? `${overruns.join("; ")} — stop consuming and wait for guidance.`
              : undefined,
        });
      }
    );

    this.server.registerTool(
      "get_budget_status",
      {
        description:
          "Check remaining budgets before planning purchases: your agent's daily/monthly " +
          "usage and limits, plus org-wide usage and limits.",
        inputSchema: {},
      },
      async () => {
        const policy = await getActivePolicy(db, orgId);
        if (!policy) return jsonError("No spend policy configured for this org.");
        const usage = await org().usage({ agentId });
        const frozen = await org().isFrozen({ agentId });
        const agentLimits = resolveAgentLimits(policy.rules, agentId);
        const orgLimits = resolveOrgLimits(policy.rules);
        return json({
          agent_id: agentId,
          frozen: frozen.frozen,
          frozen_reason: frozen.reason,
          currency: policy.rules.currency,
          agent: {
            daily_used_cents: usage.agentDailyCents,
            daily_limit_cents: agentLimits?.dailyCents ?? null,
            monthly_used_cents: usage.agentMonthlyCents,
            monthly_limit_cents: agentLimits?.monthlyCents ?? null,
          },
          org: {
            daily_used_cents: usage.orgDailyCents,
            daily_limit_cents: orgLimits?.dailyCents ?? null,
            monthly_used_cents: usage.orgMonthlyCents,
            monthly_limit_cents: orgLimits?.monthlyCents ?? null,
          },
          max_per_transaction_cents:
            policy.rules.maxPerTransactionCents ?? null,
          human_approval_at_cents: policy.rules.escalation?.amountCents ?? null,
        });
      }
    );
  }
}
