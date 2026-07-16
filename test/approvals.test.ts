import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { PolicyRules } from "../src/policy";

// Human approval flow: escalation → decision link → agent sees the result.

const POLICY: PolicyRules = {
  currency: "USD",
  escalation: { amountCents: 50_00 },
  budgets: { perAgent: { dailyCents: 200_00 } },
};

let apiKey: string;
let orgId: string;

async function mcpToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const init = await SELF.fetch("http://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id")!;
  const post = (body: unknown) =>
    SELF.fetch("http://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(body),
    });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const res = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = await res.text();
  const message = JSON.parse(
    text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .at(-1)!
      .slice("data: ".length)
  );
  return JSON.parse(message.result.content[0].text);
}

async function escalatedRequest(amountCents: number): Promise<{
  requestId: string;
  token: string;
}> {
  const result = await mcpToolCall("request_purchase", {
    vendor: "Big Ticket Vendor",
    amount_cents: amountCents,
    currency: "USD",
    category: "software",
    justification: "Annual license",
  });
  expect(result.status).toBe("pending_approval");
  const row = await env.DB.prepare(
    "SELECT token FROM decision_tokens WHERE request_id = ?"
  )
    .bind(result.request_id)
    .first<{ token: string }>();
  return { requestId: result.request_id, token: row!.token };
}

beforeAll(async () => {
  const res = await SELF.fetch("http://example.com/api/admin/orgs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": "test-admin-key",
    },
    body: JSON.stringify({
      name: "Approvals Org",
      agent_id: "buyer-agent",
      approver_email: "cfo@example.com",
      policy: POLICY,
    }),
  });
  const body = await res.json<{ org_id: string; api_key: string }>();
  orgId = body.org_id;
  apiKey = body.api_key;
});

describe("human approval flow", () => {
  it("approves via the email link and reserves budget", async () => {
    const { requestId, token } = await escalatedRequest(80_00);

    const page = await SELF.fetch(
      `http://example.com/decide/${token}/approve`
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Approved");

    const check = await mcpToolCall("check_approval", {
      request_id: requestId,
    });
    expect(check.status).toBe("approved");
    expect(check.approval_ref).toMatch(/^apr_/);
    expect(check.approver).toBe("cfo@example.com");

    const budget = await mcpToolCall("get_budget_status", {});
    expect(budget.agent.daily_used_cents).toBe(80_00);
  });

  it("denies via the email link", async () => {
    const { requestId, token } = await escalatedRequest(60_00);
    const page = await SELF.fetch(`http://example.com/decide/${token}/deny`);
    expect(page.status).toBe(200);

    const check = await mcpToolCall("check_approval", {
      request_id: requestId,
    });
    expect(check.status).toBe("denied");
  });

  it("is idempotent: a second click reports already decided", async () => {
    const { token } = await escalatedRequest(55_00);
    await SELF.fetch(`http://example.com/decide/${token}/approve`);
    const again = await SELF.fetch(
      `http://example.com/decide/${token}/approve`
    );
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("Already decided");
  });

  it("denies at approval time if the budget no longer fits", async () => {
    // 80 + 55 already reserved of the 200 daily budget; 70 does not fit.
    const { requestId, token } = await escalatedRequest(70_00);
    const page = await SELF.fetch(
      `http://example.com/decide/${token}/approve`
    );
    expect(await page.text()).toContain("Budget exceeded");

    const check = await mcpToolCall("check_approval", {
      request_id: requestId,
    });
    expect(check.status).toBe("denied");
  });

  it("rejects an invalid token", async () => {
    const res = await SELF.fetch(
      "http://example.com/decide/dt_not-a-real-token/approve"
    );
    expect(res.status).toBe(410);
  });
});
