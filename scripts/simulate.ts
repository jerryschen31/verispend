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
import { verifyBundle, type VerifiableBundle } from "./verify-bundle.ts";
import {
  crossCheckAnchor,
  verifyReceipt,
  type VerifiableReceipt,
} from "./verify-receipt.ts";
import { ap2Claims, generateIssuerKeypair, mintMandate } from "./test-issuer.ts";
import {
  crossCheckReportAnchor,
  verifyReport,
  type VerifiableReport,
} from "./verify-report.ts";

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

async function adminGetText(path: string): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-admin-key": ADMIN_KEY },
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.text();
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

  // ── Scenario 5: a team of agents racing one shared budget ──────────
  section("Scenario 5 — research team: three agents race a $50 shared budget");
  {
    const team = await adminPost(`/api/admin/orgs/${orgId}/teams`, {
      name: "research",
      agent_ids: ["res-1", "res-2", "res-3"],
      budgets: { dailyCents: 50_00 },
    });
    check(!!team.team_id, "team 'research' provisioned with a $50/day shared budget");

    const researchers = await Promise.all(
      ["res-1", "res-2", "res-3"].map((id) => agent(orgId, id))
    );
    const results: any[] = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        researchers[i % 3].call("request_purchase", {
          vendor: "TeamData",
          amount_cents: 10_00,
          currency: "USD",
          category: "data",
          justification: `parallel enrichment shard ${i + 1}/10`,
        })
      )
    );
    const approved = results.filter((r) => r.status === "approved");
    const denied = results.filter((r) => r.status === "denied");
    check(
      approved.length === 5,
      "exactly 5 of 10 concurrent $10 purchases fit the shared $50 budget",
      `got ${approved.length}`
    );
    check(
      denied.every((r) => r.rule_fired === "budget_team_daily"),
      "every excess purchase was denied by the team budget",
      `rules=${[...new Set(denied.map((r) => r.rule_fired))].join(",")}`
    );
    const sample = denied[0];
    check(
      sample?.budget?.scope === "team" && sample?.budget?.used_cents === 50_00,
      "denials carry the failing scope: team budget fully used",
      JSON.stringify(sample?.budget)
    );
    const status = await researchers[0].call("get_budget_status", {});
    check(
      status.team?.daily_used_cents === 50_00 &&
        status.team?.daily_limit_cents === 50_00,
      "every teammate sees the same shared team counters",
      JSON.stringify(status.team)
    );
  }

  // ── Scenario 6: team approval routing ──────────────────────────────
  section("Scenario 6 — ops team: escalations route to the team's approver");
  {
    await adminPost(`/api/admin/orgs/${orgId}/members`, {
      email: "lead@sim.test",
      role: "approver",
    });
    await adminPost(`/api/admin/orgs/${orgId}/teams`, {
      name: "ops",
      agent_ids: ["ops-1"],
      approver_emails: ["lead@sim.test"],
    });
    const ops = await agent(orgId, "ops-1");
    const escalated = await ops.call("request_purchase", {
      vendor: "Enterprise Tools GmbH",
      amount_cents: 120_00,
      currency: "USD",
      category: "software",
      justification: "workflow tooling — over the $100 human threshold",
    });
    check(escalated.status === "pending_approval", "ops-1's $120 purchase escalates");

    const teamless = await good.call("request_purchase", {
      vendor: "Enterprise Tools GmbH",
      amount_cents: 110_00,
      currency: "USD",
      category: "software",
      justification: "same tool, but from a teamless agent",
    });
    check(teamless.status === "pending_approval", "teamless escalation also pends");

    // Routing is on the ledger (approval_routed), so it's observable without
    // an inbox; the real emails show up in the `npm run dev` logs.
    const bundle = JSON.parse(
      await adminGetText(`/api/admin/orgs/${orgId}/export/audit-bundle.json`)
    ) as VerifiableBundle;
    const routedFor = (requestId: string) =>
      bundle.events
        .filter(
          (e) => e.event_type === "approval_routed" && e.request_id === requestId
        )
        .map((e) => JSON.parse(e.payload_json))[0];

    const teamRouted = routedFor(escalated.request_id);
    check(
      teamRouted?.source === "team" &&
        teamRouted?.recipients?.includes("lead@sim.test"),
      "ops-1's approval was routed to the team approver (source: team)",
      JSON.stringify(teamRouted)
    );
    const orgRouted = routedFor(teamless.request_id);
    check(
      orgRouted?.source === "org" &&
        orgRouted?.recipients?.includes("lead@sim.test"),
      "the teamless escalation fell back to org-wide approvers (source: org)",
      JSON.stringify(orgRouted)
    );
  }

  // ── Scenario 7: explainable decisions ───────────────────────────────
  section("Scenario 7 — explainability: every decision shows its work");
  {
    const printTrace = (label: string, trace: any[]) => {
      console.log(`  ↳ ${label}:`);
      for (const t of trace) {
        const mark = t.result === "pass" ? "·" : t.result === "triggered" ? "✗" : "—";
        console.log(
          `      ${mark} ${t.rule.padEnd(24)} ${t.result.padEnd(10)} ${t.detail ?? ""}`
        );
      }
    };

    const ok = await good.call("request_purchase", {
      vendor: "Notion",
      amount_cents: 9_00,
      currency: "USD",
      category: "software",
      justification: "workspace seat",
    });
    check(
      ok.status === "approved" &&
        ok.trace?.some(
          (t: any) => t.rule === "budget_agent_daily" && t.result === "pass"
        ),
      "an approval's trace includes the budget math that passed"
    );
    printTrace("approved purchase trace", ok.trace ?? []);

    const bad = await good.call("request_purchase", {
      vendor: "SketchyData Inc",
      amount_cents: 5_00,
      currency: "USD",
      category: "data",
      justification: "should hit the deny list",
    });
    const triggered = (bad.trace ?? []).find((t: any) => t.result === "triggered");
    check(
      bad.status === "denied" && triggered?.rule === bad.rule_fired,
      "a denial's triggered trace entry matches rule_fired",
      `rule_fired=${bad.rule_fired}, triggered=${triggered?.rule}`
    );
    printTrace("denied purchase trace", bad.trace ?? []);
  }

  // ── Scenario 8: the auditor walks away with proof ───────────────────
  section("Scenario 8 — audit export: filtered CSV + self-verifying bundle");
  {
    const today = new Date().toISOString().slice(0, 10);
    const csv = await adminGetText(
      `/api/admin/orgs/${orgId}/export/purchases.csv?from=${today}&agent=res-1`
    );
    const rows = csv.trim().split("\n").slice(1);
    check(
      rows.length === 4 && rows.every((r) => r.includes("res-1")),
      "purchases.csv?agent=res-1 returns exactly res-1's 4 requests",
      `got ${rows.length} rows`
    );

    const bundle = JSON.parse(
      await adminGetText(`/api/admin/orgs/${orgId}/export/audit-bundle.json`)
    ) as VerifiableBundle & { verification: { ok: boolean } };
    check(
      bundle.verification.ok === true,
      "the bundle's embedded chain verification passes"
    );
    const independent = await verifyBundle(bundle);
    check(
      independent.ok && independent.count === bundle.events.length,
      `independent re-verification confirms all ${independent.count} events`
    );

    const tampered = structuredClone(bundle);
    tampered.events[2].payload_json = tampered.events[2].payload_json.replace(
      /\d/,
      "9"
    );
    const caught = await verifyBundle(tampered);
    check(
      !caught.ok && caught.brokenAtSeq === tampered.events[2].seq,
      "tampering with one event is caught at the exact sequence number"
    );
  }

  // ── Scenario 9: a mandated agent presents network credentials ───────
  section("Scenario 9 — mandated-agent: payment mandates verified locally");
  const mandated = await agent(orgId, "mandated-agent");
  let mandatedRequestId = "";
  {
    // Simulate a payment network: a keypair whose PUBLIC half the org
    // registers as a trusted issuer. No call to any real network, ever.
    const issuerKeys = await generateIssuerKeypair("Ed25519");
    await adminPost(`/api/admin/orgs/${orgId}/issuers`, {
      issuer: "https://ap2.sim.test",
      scheme: "ap2",
      alg: "Ed25519",
      public_key_jwk: issuerKeys.publicJwk,
    });
    const mandate = await mintMandate(
      issuerKeys.privateJwk,
      "Ed25519",
      ap2Claims({
        iss: "https://ap2.sim.test",
        sub: "mandated-agent",
        vendors: ["CloudGPU Co"],
        maxAmountCents: 80_00,
        currency: "USD",
      })
    );

    const ok = await mandated.call("request_purchase", {
      vendor: "CloudGPU Co",
      amount_cents: 50_00,
      currency: "USD",
      category: "software",
      justification: "GPU hours under an AP2-style mandate",
      mandate,
    });
    check(
      ok.status === "approved" && ok.mandate?.status === "verified",
      "a purchase inside the mandate's scope verifies and approves",
      `status=${ok.status}, mandate=${ok.mandate?.status}`
    );
    check(
      (ok.trace ?? []).some((t: any) => t.rule === "mandate_ok" && t.result === "pass"),
      "the decision trace explains the verified mandate"
    );
    mandatedRequestId = ok.request_id;
    await mandated.call("record_outcome", {
      request_id: mandatedRequestId,
      final_amount_cents: 50_00,
      rail: "card",
      settlement_ref: "SIM-MANDATE-AUTH",
    });

    const outOfScope = await mandated.call("request_purchase", {
      vendor: "Figma",
      amount_cents: 10_00,
      currency: "USD",
      category: "software",
      justification: "vendor the mandate does not cover",
      mandate,
    });
    check(
      outOfScope.status === "denied" &&
        outOfScope.rule_fired === "mandate_scope_violation",
      "a purchase outside the mandate's vendor scope is denied",
      `rule_fired=${outOfScope.rule_fired}`
    );

    // Forge the signed payload: bump the amount limit inside the token.
    const [h, p, s] = mandate.split(".");
    const forged = `${h}.${p.slice(0, -2)}${p.endsWith("AA") ? "BB" : "AA"}.${s}`;
    const rejected = await mandated.call("request_purchase", {
      vendor: "CloudGPU Co",
      amount_cents: 10_00,
      currency: "USD",
      category: "software",
      justification: "tampered credential",
      mandate: forged,
    });
    check(
      rejected.status === "denied" && rejected.rule_fired === "mandate_invalid",
      "a tampered mandate is a hard deny with the signature called out",
      `rule_fired=${rejected.rule_fired}`
    );
  }

  // ── Scenario 10: the settlement feed arrives from three rails ───────
  section("Scenario 10 — settlement feed: cross-rail matching catches anomalies");
  const rail = await agent(orgId, "rail-agent");
  {
    const buy = async (vendor: string, amountCents: number) => {
      const res = await rail.call("request_purchase", {
        vendor,
        amount_cents: amountCents,
        currency: "USD",
        category: "software",
        justification: `cross-rail purchase at ${vendor}`,
      });
      return res.request_id as string;
    };

    // Card purchase, agent reports the auth code at record_outcome.
    const cardReq = await buy("RailCard Vendor", 20_00);
    await rail.call("record_outcome", {
      request_id: cardReq,
      final_amount_cents: 20_00,
      rail: "card",
      settlement_ref: "SIM-AUTH-1",
    });
    // Stripe purchase, agent reports no ref — heuristics must catch it.
    const stripeReq = await buy("RailStripe Vendor", 35_00);
    await rail.call("record_outcome", { request_id: stripeReq, final_amount_cents: 35_00 });
    // Checkout purchase that the merchant will over-charge.
    const shopReq = await buy("RailShop Vendor", 25_00);
    await rail.call("record_outcome", {
      request_id: shopReq,
      final_amount_cents: 25_00,
      rail: "checkout",
      settlement_ref: "SIM-ORD-3",
    });

    const push = async (railName: string, payload: Record<string, unknown>) =>
      (await adminPost(`/api/admin/orgs/${orgId}/settlements`, { rail: railName, ...payload }))
        .results[0];

    const nowIso = new Date().toISOString();
    const cardMatch = await push("card", {
      auth_code: "SIM-AUTH-1",
      merchant: "RailCard Vendor",
      amount_cents: 20_00,
      currency: "USD",
      posted_at: nowIso,
    });
    check(
      cardMatch.match_status === "matched" &&
        cardMatch.match_method === "settlement_ref" &&
        cardMatch.matched_request_id === cardReq,
      "card settlement matches exactly via the agent-reported auth code",
      JSON.stringify(cardMatch)
    );

    const stripeMatch = await push("stripe_event", {
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_sim_1",
          amount: 35_00,
          currency: "usd",
          description: "RailStripe Vendor",
          created: Math.floor(Date.now() / 1000),
        },
      },
    });
    check(
      stripeMatch.match_status === "matched" &&
        stripeMatch.match_method === "heuristic" &&
        stripeMatch.matched_request_id === stripeReq,
      "a Stripe-shaped event with no shared ref still matches heuristically",
      JSON.stringify(stripeMatch)
    );

    const overcharge = await push("checkout", {
      order_id: "SIM-ORD-3",
      merchant: "RailShop Vendor",
      total_cents: 40_00,
      currency: "USD",
      completed_at: nowIso,
    });
    check(
      overcharge.match_status === "amount_mismatch" &&
        overcharge.variance_cents === 15_00,
      "an over-charged settlement is flagged with the exact variance",
      JSON.stringify(overcharge)
    );

    const rogue = await push("card", {
      auth_code: "SIM-ROGUE",
      merchant: "Phantom Vendor Ltd",
      amount_cents: 60_00,
      currency: "USD",
      posted_at: nowIso,
    });
    check(
      rogue.match_status === "unauthorized" && rogue.matched_request_id === null,
      "a charge no agent ever requested is flagged unauthorized",
      JSON.stringify(rogue)
    );

    // The mandated purchase from scenario 9 settles cleanly too.
    const mandateSettle = await push("card", {
      auth_code: "SIM-MANDATE-AUTH",
      merchant: "CloudGPU Co",
      amount_cents: 50_00,
      currency: "USD",
      posted_at: nowIso,
    });
    check(
      mandateSettle.match_status === "matched" &&
        mandateSettle.matched_request_id === mandatedRequestId,
      "the mandated purchase's settlement matches its reported ref"
    );
  }

  // ── Scenario 11: a verifiable receipt survives independent scrutiny ─
  section("Scenario 11 — receipt: signed proof, verified with zero VeriSpend code");
  {
    const receipt = JSON.parse(
      await (async () => {
        const res = await fetch(
          `${BASE_URL}/api/admin/orgs/${orgId}/requests/${mandatedRequestId}/receipt`,
          { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY }, body: "{}" }
        );
        if (!res.ok) throw new Error(`receipt issuance failed (${res.status}): ${await res.text()}`);
        return res.text();
      })()
    ) as VerifiableReceipt;

    const verdict = await verifyReceipt(receipt);
    check(
      verdict.ok,
      "the receipt's Ed25519 signature verifies offline",
      verdict.reason
    );
    const payload = JSON.parse(receipt.payload_json);
    check(
      payload.mandate?.verification_status === "verified" &&
        payload.settlement?.match_status === "matched",
      "one receipt attests the full chain: mandate → approval → settlement match"
    );

    const wellKnown: any = await (await fetch(`${BASE_URL}/.well-known/verispend-keys.json`)).json();
    check(
      wellKnown.keys.some((k: any) => k.kid === receipt.signature.key_id),
      "the signing key is published at /.well-known/verispend-keys.json"
    );

    const bundle = JSON.parse(
      await adminGetText(`/api/admin/orgs/${orgId}/export/audit-bundle.json`)
    ) as VerifiableBundle;
    const anchors = crossCheckAnchor(receipt, bundle);
    check(
      anchors.ok,
      `all ${anchors.checked} anchored ledger hashes appear in the verified audit bundle`,
      anchors.reason
    );

    const tampered: VerifiableReceipt = {
      ...receipt,
      payload_json: receipt.payload_json.replace('"amount_cents":5000', '"amount_cents":500000'),
    };
    const caught = await verifyReceipt(tampered);
    check(
      !caught.ok,
      "inflating the amount inside the receipt breaks the signature",
      caught.ok ? "tampering went undetected!" : undefined
    );
  }

  // ── Scenario 12: the compliance report an auditor can take away ─────
  section("Scenario 12 — compliance report: audit-ready, signed, framework-mapped");
  {
    const report = (await adminPost(
      `/api/admin/orgs/${orgId}/reports`,
      {}
    )) as VerifiableReport;
    check(
      report.format === "verispend-compliance-report",
      "the admin API generates a signed compliance report"
    );

    const verdict = await verifyReport(report);
    check(
      verdict.ok,
      "the report's Ed25519 signature verifies offline (zero VeriSpend code)",
      verdict.reason
    );

    const payload = JSON.parse(report.payload_json);
    check(
      payload.chain_verification.ok === true,
      "the report embeds a full hash-chain verification of the ledger"
    );
    check(
      ["nist-ai-rmf", "iso-42001", "sox-itgc"].every((id) =>
        payload.frameworks.some(
          (f: any) => f.id === id && f.controls.length >= 7
        )
      ),
      "controls are mapped across NIST AI RMF, ISO/IEC 42001, and SOX-style objectives"
    );
    const iso628 = payload.frameworks
      .find((f: any) => f.id === "iso-42001")
      .controls.find((c: any) => c.control_id === "A.6.2.8");
    check(
      iso628?.status === "evidenced",
      "ISO 42001 A.6.2.8 (event logging) is evidenced by the verified chain"
    );

    check(
      payload.exceptions.unauthorized_charges.some(
        (s: any) => s.vendor === "Phantom Vendor Ltd"
      ),
      "scenario 10's unauthorized charge surfaces in the exceptions for the auditor"
    );
    check(
      payload.exceptions.overbilled_bills.some(
        (b: any) => b.vendor === "InferenceCloud"
      ),
      "scenario 3's over-billed invoice surfaces in the exceptions"
    );
    check(
      payload.exceptions.frozen_agents.length >= 2,
      "the frozen loop-agent and injected-agent appear as open incidents"
    );
    check(
      payload.activity.receipts_issued >= 1 &&
        payload.activity.mandates.verified >= 1,
      "the report counts scenario 9/11's verified mandate and signed receipt"
    );

    const bundle = JSON.parse(
      await adminGetText(`/api/admin/orgs/${orgId}/export/audit-bundle.json`)
    ) as VerifiableBundle;
    const anchors = crossCheckReportAnchor(report, bundle);
    check(
      anchors.ok,
      `the report's ${anchors.checked} ledger anchors appear in the verified audit bundle`,
      anchors.reason
    );
    check(
      bundle.events.some((e) => e.event_type === "report_generated"),
      "generating the report is itself an event on the tamper-evident chain"
    );

    const tampered: VerifiableReport = {
      ...report,
      payload_json: report.payload_json.replace(
        "Phantom Vendor Ltd",
        "Innocent Vendor Co"
      ),
    };
    const caught = await verifyReport(tampered);
    check(
      !caught.ok,
      "whitewashing an exception inside the report breaks the signature",
      caught.ok ? "tampering went undetected!" : undefined
    );

    const stored = JSON.parse(
      await adminGetText(`/api/admin/orgs/${orgId}/reports/${report.report_id}`)
    ) as VerifiableReport;
    check(
      stored.signature.sig === report.signature.sig,
      "the stored report re-serves verbatim for later audits"
    );
  }

  // ── Wrap up ─────────────────────────────────────────────────────────
  section("Result");
  console.log(`  ${passed} checks passed, ${failed} failed`);
  console.log(
    `\nDemo org ${orgId} is live: frozen agents (loop-agent, injected-agent), an` +
      `\noverbilled InferenceCloud invoice, a research team that exhausted its shared` +
      `\nbudget, three pending approvals (one routed to lead@sim.test), a mandated` +
      `\npurchase with a signed verifiable receipt, a cross-rail settlement feed with` +
      `\nan over-charge and an unauthorized charge, a verified audit bundle, and a` +
      `\nsigned compliance report mapped to NIST AI RMF, ISO 42001, and SOX-style` +
      `\ncontrols (dashboard → Reports).` +
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
