// Phase 4 end-to-end: drive a realistic mix of agent activity — approved,
// denied, and human-decided purchases, metered usage with an over-billed
// bill, verified and forged mandates, matched/mismatched/unauthorized
// settlements, a signed receipt — then generate the compliance report and
// verify it the way an auditor would: offline, from the embedded recipe.

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  crossCheckReportAnchor,
  verifyReport,
  type VerifiableReport,
} from "../scripts/verify-report.ts";
import { verifyBundle, type VerifiableBundle } from "../scripts/verify-bundle.ts";
import {
  ap2Claims,
  generateIssuerKeypair,
  mintMandate,
} from "../scripts/test-issuer.ts";
import type { ReportDocument, ReportPayload } from "../src/report";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/session";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ISSUER = "https://network.report.test";
const ADMIN_EMAIL = "cfo@report.test";

const POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 200_00,
  vendors: { deny: ["Shady Vendor"] },
  escalation: { amountCents: 100_00 },
  budgets: { perAgent: { dailyCents: 1000_00 } },
};

const admin = { "content-type": "application/json", "x-admin-key": "test-admin-key" };
const adminPost = (path: string, body: Record<string, unknown>) =>
  SELF.fetch(`http://example.com${path}`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify(body),
  });

describe("compliance report end to end", () => {
  let orgId: string;
  let agent: McpSession;
  let report: ReportDocument;
  let payload: ReportPayload;

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Report Org",
      agentId: "rep-agent",
      approverEmail: ADMIN_EMAIL,
      policy: POLICY,
    });
    orgId = org.orgId;
    agent = new McpSession(org.apiKey);
    expect(await agent.initialize()).toBe(200);

    // Trusted issuer + a forger the org never registered.
    const network = await generateIssuerKeypair("Ed25519");
    const forger = await generateIssuerKeypair("Ed25519");
    await adminPost(`/api/admin/orgs/${orgId}/issuers`, {
      issuer: ISSUER,
      scheme: "ap2",
      alg: "Ed25519",
      public_key_jwk: network.publicJwk,
    });

    const buy = (args: Record<string, unknown>) =>
      agent.call("request_purchase", {
        currency: "USD",
        category: "software",
        justification: "report fixtures",
        ...args,
      });

    // Approved with a verified mandate → outcome → matched settlement.
    const mandate = await mintMandate(
      network.privateJwk,
      "Ed25519",
      ap2Claims({
        iss: ISSUER,
        sub: "rep-agent",
        vendors: ["Figma"],
        maxAmountCents: 100_00,
        currency: "USD",
      })
    );
    const approved = await buy({ vendor: "Figma", amount_cents: 20_00, mandate });
    expect(approved.status).toBe("approved");
    await agent.call("record_outcome", {
      request_id: approved.request_id,
      final_amount_cents: 20_00,
      rail: "card",
      settlement_ref: "AUTH-REP-1",
    });
    await adminPost(`/api/admin/orgs/${orgId}/settlements`, {
      rail: "card",
      auth_code: "AUTH-REP-1",
      merchant: "Figma",
      amount_cents: 20_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    });

    // Denied by the vendor deny-list.
    const denied = await buy({ vendor: "Shady Vendor", amount_cents: 10_00 });
    expect(denied.status).toBe("denied");

    // Forged mandate → hard deny + mandate_rejected on the chain.
    const forged = await mintMandate(
      forger.privateJwk,
      "Ed25519",
      ap2Claims({
        iss: ISSUER,
        sub: "rep-agent",
        vendors: ["Figma"],
        maxAmountCents: 100_00,
        currency: "USD",
      })
    );
    const rejected = await buy({ vendor: "Figma", amount_cents: 5_00, mandate: forged });
    expect(rejected.status).toBe("denied");

    // Escalated purchase, approved by a human via the one-click link.
    const pending = await buy({ vendor: "Big Vendor", amount_cents: 150_00 });
    expect(pending.status).toBe("pending_approval");
    const tokenRow = await env.DB.prepare(
      "SELECT token FROM decision_tokens WHERE request_id = ?"
    )
      .bind(pending.request_id)
      .first<{ token: string }>();
    const decided = await SELF.fetch(
      `http://example.com/decide/${tokenRow!.token}/approve`
    );
    expect(decided.status).toBe(200);

    // Metered usage the provider then over-bills.
    await agent.call("record_usage", {
      vendor: "ComputeCo",
      metric: "gpu_hours",
      units: 3,
      expected_cost_cents: 9_00,
    });
    const today = new Date().toISOString().slice(0, 10);
    await adminPost(`/api/admin/orgs/${orgId}/bills`, {
      vendor: "ComputeCo",
      period_start: today,
      period_end: today,
      amount_cents: 25_00,
    });

    // A settlement that over-charges an approved purchase, and one no agent
    // ever requested.
    const mismatched = await buy({ vendor: "Overcharger", amount_cents: 30_00 });
    expect(mismatched.status).toBe("approved");
    await agent.call("record_outcome", {
      request_id: mismatched.request_id,
      final_amount_cents: 30_00,
      rail: "card",
      settlement_ref: "AUTH-REP-2",
    });
    await adminPost(`/api/admin/orgs/${orgId}/settlements`, {
      rail: "card",
      auth_code: "AUTH-REP-2",
      merchant: "Overcharger",
      amount_cents: 45_00,
      currency: "USD",
      posted_at: new Date().toISOString(),
    });
    await adminPost(`/api/admin/orgs/${orgId}/settlements`, {
      rail: "stablecoin",
      tx_hash: "0xrogue",
      payee: "Rogue Vendor",
      amount_cents: 66_00,
      currency: "USD",
      block_time: new Date().toISOString(),
    });

    // A signed receipt for the mandated purchase.
    await agent.call("get_receipt", { request_id: approved.request_id });

    // Generate the report through the admin API (the dev/prod demo path).
    const res = await adminPost(`/api/admin/orgs/${orgId}/reports`, {});
    expect(res.status).toBe(200);
    report = (await res.json()) as ReportDocument;
    payload = JSON.parse(report.payload_json) as ReportPayload;
  });

  it("verifies offline from the embedded recipe, like an auditor would", async () => {
    expect(report.format).toBe("verispend-compliance-report");
    expect(await verifyReport(report as VerifiableReport)).toEqual({ ok: true });

    // Any altered byte of the signed payload breaks the signature.
    const tampered = {
      ...report,
      payload_json: report.payload_json.replace(
        '"positioning"',
        '"positioning_"'
      ),
    };
    expect(tampered.payload_json).not.toBe(report.payload_json);
    expect(await verifyReport(tampered as VerifiableReport)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signature"),
    });
  });

  it("embeds a verified chain and anchors that cross-check against the bundle", async () => {
    expect(payload.chain_verification.ok).toBe(true);
    expect(payload.ledger_anchor.chain_head).toBeTruthy();
    expect(payload.ledger_anchor.first_event!.seq).toBeLessThanOrEqual(
      payload.ledger_anchor.last_event!.seq
    );

    const bundleRes = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/export/audit-bundle.json`,
      { headers: { "x-admin-key": "test-admin-key" } }
    );
    const bundle = (await bundleRes.json()) as VerifiableBundle;
    expect((await verifyBundle(bundle)).ok).toBe(true);
    expect(
      crossCheckReportAnchor(report as VerifiableReport, bundle)
    ).toMatchObject({ ok: true });
  });

  it("summarizes the period's activity accurately", () => {
    const { purchases, mandates } = payload.activity;
    expect(purchases.by_status.denied).toBe(2); // deny-list + forged mandate
    expect(purchases.by_status.completed).toBe(2); // both outcomes recorded
    expect(purchases.by_status.approved).toBe(1); // the human-approved one
    expect(purchases.denied_by_rule).toMatchObject({
      vendor_denied: 1,
      mandate_invalid: 1,
    });
    expect(mandates).toEqual({ verified: 1, rejected: 1 });
    expect(payload.activity.bills_by_recon_status.overbilled).toBe(1);
    expect(payload.activity.settlements_by_match_status).toMatchObject({
      matched: 1,
      amount_mismatch: 1,
      unauthorized: 1,
    });
    expect(payload.activity.receipts_issued).toBe(1);
    expect(payload.activity.events_by_type.human_decision).toBe(1);
  });

  it("resolves controls across all three frameworks with citable evidence", () => {
    expect(payload.frameworks.map((f) => f.id).sort()).toEqual([
      "iso-42001",
      "nist-ai-rmf",
      "sox-itgc",
    ]);
    for (const fw of payload.frameworks) {
      expect(fw.controls.length).toBeGreaterThanOrEqual(7);
    }

    const control = (fwId: string, controlId: string) =>
      payload.frameworks
        .find((f) => f.id === fwId)!
        .controls.find((c) => c.control_id === controlId)!;

    // The ledger IS the ISO event-log control: verified chain + activity.
    expect(control("iso-42001", "A.6.2.8").status).toBe("evidenced");

    // Human oversight fired: escalation configured + human decisions present.
    const oversight = control("nist-ai-rmf", "GOVERN 3.2");
    expect(oversight.status).toBe("evidenced");
    const eventEvidence = oversight.evidence.find((e) => e.kind === "event_present")!;
    expect(eventEvidence.refs!.length).toBeGreaterThanOrEqual(1);
    expect(eventEvidence.refs![0].hash).toMatch(/^[0-9a-f]{64}$/);

    // Emergent-risk tracking flags the seeded incidents for attention.
    expect(control("nist-ai-rmf", "MEASURE 3.1").status).toBe("attention");
    expect(control("sox-itgc", "REC-1").status).toBe("attention");

    // Change management and access lifecycle are evidenced from the
    // control-plane events (org_created seeds both).
    expect(control("sox-itgc", "CM-1").status).toBe("evidenced");
    expect(control("sox-itgc", "ACCESS-1").status).toBe("evidenced");
  });

  it("lists the seeded exceptions for the auditor", () => {
    expect(payload.exceptions.unauthorized_charges).toHaveLength(1);
    expect(payload.exceptions.unauthorized_charges[0]).toMatchObject({
      vendor: "Rogue Vendor",
      amount_cents: 66_00,
    });
    expect(payload.exceptions.overbilled_bills).toHaveLength(1);
    expect(payload.exceptions.overbilled_bills[0].vendor).toBe("ComputeCo");
    expect(payload.exceptions.settlement_amount_mismatches).toHaveLength(1);
    expect(
      payload.exceptions.settlement_amount_mismatches[0].variance_cents
    ).toBe(15_00);
    expect(payload.exceptions.frozen_agents).toHaveLength(0);
  });

  it("persists the report, re-serves it verbatim, and chains its issuance", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/reports/${report.report_id}`,
      { headers: { "x-admin-key": "test-admin-key" } }
    );
    expect(res.status).toBe(200);
    const stored = (await res.json()) as ReportDocument;
    expect(stored.payload_json).toBe(report.payload_json);
    expect(stored.signature.sig).toBe(report.signature.sig);

    const event = await env.DB.prepare(
      `SELECT payload_json FROM ledger_events
       WHERE org_id = ? AND event_type = 'report_generated' AND request_id = ?`
    )
      .bind(orgId, report.report_id)
      .first<{ payload_json: string }>();
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      reportId: report.report_id,
      issuedBy: "admin-api",
      keyId: report.signature.key_id,
    });

    // The signing key is discoverable out of band.
    const keys = await SELF.fetch("http://example.com/.well-known/verispend-keys.json");
    const { keys: published } = await keys.json<{ keys: Array<{ kid: string }> }>();
    expect(published.map((k) => k.kid)).toContain(report.signature.key_id);
  });

  it("respects a period filter", async () => {
    const res = await adminPost(`/api/admin/orgs/${orgId}/reports`, {
      period_start: "2020-01-01",
      period_end: "2020-01-31",
    });
    expect(res.status).toBe(200);
    const empty = JSON.parse(
      ((await res.json()) as ReportDocument).payload_json
    ) as ReportPayload;
    expect(empty.period).toEqual({ start: "2020-01-01", end: "2020-01-31" });
    expect(empty.activity.purchases.total).toBe(0);
    expect(empty.ledger_anchor.first_event).toBeNull();
    // Chain verification is period-independent — the whole chain verifies.
    expect(empty.chain_verification.ok).toBe(true);
    // No activity in the window: event-backed controls report no_activity,
    // and clean exception scans still count as evidence of absence.
    const iso = empty.frameworks.find((f) => f.id === "iso-42001")!;
    expect(iso.controls.find((c) => c.control_id === "A.9.2")!.status).toBe(
      "no_activity"
    );
  });

  describe("dashboard Reports page", () => {
    const mintCookie = async (email: string) =>
      `${SESSION_COOKIE}=${await signToken("test-session-secret", {
        purpose: "session",
        email,
        orgId,
        exp: Date.now() + SESSION_TTL_MS,
      })}`;

    it("lets an admin generate and view a printable report", async () => {
      const cookie = await mintCookie(ADMIN_EMAIL);
      const generated = await SELF.fetch("http://example.com/dashboard/reports", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "",
        redirect: "manual",
      });
      expect(generated.status).toBe(302);
      const location = generated.headers.get("location")!;
      expect(location).toMatch(/^\/dashboard\/reports\/crpt_/);

      const page = await SELF.fetch(`http://example.com${location}`, {
        headers: { cookie },
      });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Agent spend compliance report");
      expect(html).toContain("Report Org");
      expect(html).toContain("Hash chain verified");
      expect(html).toContain("A.6.2.8");
      expect(html).toContain("Rogue Vendor");

      const download = await SELF.fetch(
        `http://example.com${location}/report.json`,
        { headers: { cookie } }
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain("attachment");
      const doc = (await download.json()) as ReportDocument;
      expect(await verifyReport(doc as VerifiableReport)).toEqual({ ok: true });

      const list = await SELF.fetch("http://example.com/dashboard/reports", {
        headers: { cookie },
      });
      expect(await list.text()).toContain(doc.report_id);
    });

    it("lets viewers read reports but not generate them", async () => {
      await adminPost(`/api/admin/orgs/${orgId}/members`, {
        email: "viewer@report.test",
        role: "viewer",
      });
      const cookie = await mintCookie("viewer@report.test");
      const view = await SELF.fetch(
        `http://example.com/dashboard/reports/${report.report_id}`,
        { headers: { cookie } }
      );
      expect(view.status).toBe(200);
      const generate = await SELF.fetch("http://example.com/dashboard/reports", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: "",
        redirect: "manual",
      });
      expect(generate.status).toBe(403);
    });
  });

  it("rejects bad admin keys and unknown orgs", async () => {
    const bad = await SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    const missing = await adminPost("/api/admin/orgs/org_nope/reports", {});
    expect(missing.status).toBe(404);
  });
});
