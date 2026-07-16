import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../src/ledger";
import type { PolicyRules } from "../src/policy";

// Drives the real Streamable HTTP MCP transport end-to-end.

const TEST_POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 500_00,
  categories: { deny: ["gambling"] },
  escalation: { amountCents: 200_00 },
  budgets: { perAgent: { dailyCents: 300_00 } },
};

let apiKey: string;
let orgId: string;

async function provisionOrg(): Promise<void> {
  const res = await SELF.fetch("http://example.com/api/admin/orgs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": "test-admin-key" },
    body: JSON.stringify({
      name: "Test Org",
      agent_id: "test-agent",
      approver_email: "cfo@example.com",
      policy: TEST_POLICY,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ org_id: string; api_key: string }>();
  orgId = body.org_id;
  apiKey = body.api_key;
}

function parseSseJson(text: string): any {
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  return dataLines.at(-1);
}

class McpSession {
  #sessionId: string | undefined;
  #nextId = 1;

  async #post(body: unknown): Promise<Response> {
    return SELF.fetch("http://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
        ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async initialize(): Promise<void> {
    const res = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    this.#sessionId = res.headers.get("mcp-session-id") ?? undefined;
    expect(this.#sessionId).toBeTruthy();
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Calls a tool and returns the parsed JSON body of its text content. */
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(res.status).toBe(200);
    const message = parseSseJson(await res.text());
    expect(message.error).toBeUndefined();
    return JSON.parse(message.result.content[0].text);
  }
}

beforeAll(async () => {
  await provisionOrg();
});

describe("MCP purchase flow", () => {
  it("rejects requests without a valid API key", async () => {
    const res = await SELF.fetch("http://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("auto-approves an in-policy purchase and records the outcome", async () => {
    const session = new McpSession();
    await session.initialize();

    const approval = await session.call("request_purchase", {
      vendor: "Acme Data Co",
      amount_cents: 45_00,
      currency: "USD",
      category: "data",
      justification: "Lead enrichment for outbound campaign",
    });
    expect(approval.status).toBe("approved");
    expect(approval.approval_ref).toMatch(/^apr_/);

    const outcome = await session.call("record_outcome", {
      request_id: approval.request_id,
      final_amount_cents: 43_50,
      receipt: "Order #A-1001",
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.variance_from_approval_cents).toBe(-1_50);

    const budget = await session.call("get_budget_status", {});
    expect(budget.agent.daily_used_cents).toBe(43_50);
    expect(budget.agent.daily_limit_cents).toBe(300_00);
  });

  it("denies a purchase in a denied category", async () => {
    const session = new McpSession();
    await session.initialize();

    const result = await session.call("request_purchase", {
      vendor: "Lucky Casino",
      amount_cents: 10_00,
      currency: "USD",
      category: "gambling",
      justification: "testing",
    });
    expect(result.status).toBe("denied");
    expect(result.rule_fired).toBe("category_denied");
  });

  it("escalates large purchases to pending_approval", async () => {
    const session = new McpSession();
    await session.initialize();

    const result = await session.call("request_purchase", {
      vendor: "Conference Corp",
      amount_cents: 250_00,
      currency: "USD",
      category: "events",
      justification: "Sponsor booth",
    });
    expect(result.status).toBe("pending_approval");

    const check = await session.call("check_approval", {
      request_id: result.request_id,
    });
    expect(check.status).toBe("pending_approval");
  });

  it("denies once the agent daily budget is exhausted", async () => {
    const session = new McpSession();
    await session.initialize();

    // 43.50 already used; two more $99 purchases fit under $300, a third doesn't.
    for (let i = 0; i < 2; i++) {
      const r = await session.call("request_purchase", {
        vendor: "API Credits Inc",
        amount_cents: 99_00,
        currency: "USD",
        category: "software",
        justification: `Batch ${i}`,
      });
      expect(r.status).toBe("approved");
    }
    const denied = await session.call("request_purchase", {
      vendor: "API Credits Inc",
      amount_cents: 99_00,
      currency: "USD",
      category: "software",
      justification: "One too many",
    });
    expect(denied.status).toBe("denied");
    expect(denied.rule_fired).toBe("budget_agent_daily");
  });

  it("keeps a verifiable ledger across the whole session", async () => {
    const verification = await verifyLedgerChain(env.DB, orgId);
    expect(verification.ok).toBe(true);
    // 6 requests × 2 events + 1 outcome event + 1 approval_routed event
    expect(verification).toMatchObject({ count: 14 });
  });
});
