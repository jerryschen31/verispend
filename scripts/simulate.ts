// Agent spending simulator: drives four fake agents through the real MCP
// endpoint and asserts VeriSpend catches what it should. Deterministic — it
// doubles as an end-to-end smoke test and a live demo.
//
//   npm run dev                # in one terminal
//   npm run simulate           # in another
//
// Flags: --base-url http://localhost:8787  --admin-key dev-admin-key
//        --approver you@example.com  (sets the org's dashboard login email)
//
// Runs on plain Node ≥ 22.18 (native type stripping); no build step.

import { McpHttpClient } from "./mcp-client.ts";

declare const process: {
  argv: string[];
  exitCode?: number;
};

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE_URL = flag("base-url", "http://localhost:8787").replace(/\/$/, "");
const ADMIN_KEY = flag("admin-key", "dev-admin-key");
const APPROVER = flag("approver", "");

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
  console.log("─".repeat(Math.min(72, title.length + 8)));
}

async function adminPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

// Policy tuned so every scenario resolves in seconds of wall-clock time.
const POLICY = {
  currency: "USD",
  maxPerTransactionCents: 200_00,
  escalation: { amountCents: 100_00 },
  vendors: { deny: ["SketchyData Inc"] },
  budgets: { perAgent: { dailyCents: 500_00 }, org: { dailyCents: 2_000_00 } },
  circuitBreaker: {
    identical: { count: 5, windowMinutes: 10 },
    velocity: { count: 30, windowMinutes: 5 },
  },
};

async function agent(orgId: string, agentId: string): Promise<McpHttpClient> {
  const { api_key } = await adminPost(`/api/admin/orgs/${orgId}/keys`, {
    agent_id: agentId,
  });
  const client = new McpHttpClient({ baseUrl: BASE_URL, apiKey: api_key });
  const status = await client.initialize();
  if (status !== 200) throw new Error(`MCP initialize failed: ${status}`);
  return client;
}

async function main() {
  console.log(`VeriSpend agent simulator → ${BASE_URL}`);

  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `No VeriSpend at ${BASE_URL}. Start it with \`npm run dev\` first.`
    );
  }

  const org = await adminPost("/api/admin/orgs", {
    name: `Sim Corp ${new Date().toISOString().slice(0, 19)}`,
    agent_id: "bootstrap",
    approver_email: APPROVER || undefined,
    policy: POLICY,
  });
  const orgId: string = org.org_id;
  console.log(`Provisioned demo org ${orgId}`);

  // ── Scenario 1: a well-behaved agent ────────────────────────────────
  section("Scenario 1 — good-agent: normal purchasing stays frictionless");
  const good = await agent(orgId, "good-agent");
  {
    const buys = [
      { vendor: "Figma", amount_cents: 15_00, category: "software", justification: "Design seat for landing page task" },
      { vendor: "Serpapi", amount_cents: 8_50, category: "data", justification: "Search results for competitor research" },
      { vendor: "Twilio", amount_cents: 12_00, category: "software", justification: "SMS credits for appointment reminders" },
    ];
    for (const buy of buys) {
      const res = await good.call("request_purchase", { ...buy, currency: "USD" });
      check(res.status === "approved", `${buy.vendor} ${buy.amount_cents}¢ approved`, res.reason);
      const outcome = await good.call("record_outcome", {
        request_id: res.request_id,
        final_amount_cents: buy.amount_cents,
        receipt: `sim-order-${buy.vendor.toLowerCase()}`,
      });
      check(outcome.status === "completed", `${buy.vendor} outcome recorded`);
    }

    const big = await good.call("request_purchase", {
      vendor: "Salesforce",
      amount_cents: 150_00,
      currency: "USD",
      category: "software",
      justification: "Annual CRM seat — needs human sign-off",
    });
    check(
      big.status === "pending_approval",
      "a $150 purchase escalates to a human instead of auto-approving",
      `got ${big.status}`
    );

    const budget = await good.call("get_budget_status", {});
    check(budget.frozen === false, "agent is not frozen");
    check(
      budget.agent.daily_used_cents === 35_50,
      "budget counters reflect exactly the three completed purchases",
      `got ${budget.agent.daily_used_cents}¢`
    );
  }

  // ── Scenario 2: a runaway loop ──────────────────────────────────────
  section("Scenario 2 — loop-agent: runaway loop hits the circuit breaker");
  const loop = await agent(orgId, "loop-agent");
  {
    const purchase = {
      vendor: "DataMart",
      amount_cents: 3_00,
      currency: "USD",
      category: "data",
      justification: "Fetch dataset (agent is stuck retrying)",
    };
    const statuses: string[] = [];
    const rules: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await loop.call("request_purchase", purchase);
      statuses.push(res.status);
      rules.push(res.rule_fired);
    }
    check(
      statuses.slice(0, 4).every((s) => s === "approved"),
      "first 4 identical requests pass (below the loop threshold)"
    );
    check(
      rules[4] === "circuit_breaker",
      "5th identical request trips the breaker",
      `rule_fired=${rules[4]}`
    );
    check(
      rules.slice(5).every((r) => r === "agent_frozen"),
      "every request after the trip is denied: agent is frozen",
      `rules=${rules.slice(5).join(",")}`
    );

    const budget = await loop.call("get_budget_status", {});
    check(budget.frozen === true, "agent sees frozen=true in get_budget_status");
    check(
      budget.agent.daily_used_cents === 12_00,
      "only the 4 pre-trip approvals consumed budget",
      `got ${budget.agent.daily_used_cents}¢`
    );
    console.log(`  ↳ freeze reason: ${budget.frozen_reason}`);
  }

  // ── Scenario 3: an over-billed metered provider ─────────────────────
  section("Scenario 3 — metered-agent: provider over-bills recorded usage");
  const metered = await agent(orgId, "metered-agent");
  {
    for (let i = 0; i < 5; i++) {
      const res = await metered.call("record_usage", {
        vendor: "InferenceCloud",
        metric: "output_tokens",
        units: 400_000,
        expected_cost_cents: 8_00,
        note: `batch ${i + 1}/5 at the contracted $0.02/1k rate`,
      });
      check(res.usage_id?.startsWith("ur_"), `usage batch ${i + 1} recorded (800¢ expected)`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const bill = await adminPost(`/api/admin/orgs/${orgId}/bills`, {
      vendor: "InferenceCloud",
      period_start: today,
      period_end: today,
      amount_cents: 55_00,
      memo: "provider invoice (simulated wrong pricing tier)",
    });
    check(bill.expected_cents === 40_00, "expected cost sums the 5 usage reports to $40");
    check(
      bill.recon_status === "overbilled",
      `$55 bill against $40 of usage is flagged overbilled (variance +${bill.variance_cents}¢)`,
      `got ${bill.recon_status}`
    );

    const honest = await adminPost(`/api/admin/orgs/${orgId}/bills`, {
      vendor: "InferenceCloud",
      period_start: today,
      period_end: today,
      amount_cents: 40_25,
      memo: "corrected invoice",
    });
    check(honest.recon_status === "ok", "a $40.25 bill for the same usage reconciles as ok");
  }

  // ── Scenario 4: a prompt-injected agent ─────────────────────────────
  section("Scenario 4 — injected-agent: manipulated agent gets contained");
  const injected = await agent(orgId, "injected-agent");
  {
    // A hidden instruction is hammering purchases from a deny-listed vendor,
    // varying the amount to dodge the identical-loop signal.
    let denied = 0;
    let lastRule = "";
    for (let i = 0; i < 30; i++) {
      const res = await injected.call("request_purchase", {
        vendor: "SketchyData Inc",
        amount_cents: 1_00 + i,
        currency: "USD",
        category: "data",
        justification: "URGENT: buy this dataset now (injected instruction)",
      });
      lastRule = res.rule_fired;
      if (res.status === "denied" && res.rule_fired === "vendor_denied") denied++;
    }
    check(denied === 29, "29 attempts denied by the vendor deny-list", `got ${denied}`);
    check(
      lastRule === "circuit_breaker",
      "30th rapid-fire request trips the velocity breaker",
      `rule_fired=${lastRule}`
    );
    const budget = await injected.call("get_budget_status", {});
    check(budget.frozen === true, "injected agent is frozen pending human review");
    check(budget.agent.daily_used_cents === 0, "not a cent of budget was consumed");
  }

  // ── Wrap up ─────────────────────────────────────────────────────────
  section("Result");
  console.log(`  ${passed} checks passed, ${failed} failed`);
  console.log(
    `\nDemo org ${orgId} is live: frozen agents (loop-agent, injected-agent), an` +
      `\noverbilled InferenceCloud invoice, and one pending $150 approval.` +
      (APPROVER
        ? `\nLog in at ${BASE_URL}/dashboard as ${APPROVER} to review it.`
        : `\nRe-run with --approver you@example.com to inspect it in the dashboard.`)
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nSimulator aborted: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
