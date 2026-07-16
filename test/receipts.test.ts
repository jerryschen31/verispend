import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { computeKeyId, issueReceipt, type ReceiptDocument } from "../src/receipts";
import {
  crossCheckAnchor,
  verifyReceipt,
  type VerifiableReceipt,
} from "../scripts/verify-receipt.ts";
import { verifyBundle, type VerifiableBundle } from "../scripts/verify-bundle.ts";
import {
  ap2Claims,
  generateIssuerKeypair,
  mintMandate,
} from "../scripts/test-issuer.ts";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ISSUER = "https://issuer.receipts.test";

const POLICY: PolicyRules = {
  currency: "USD",
  maxPerTransactionCents: 500_00,
  budgets: { perAgent: { dailyCents: 2000_00 } },
};

const admin = { "content-type": "application/json", "x-admin-key": "test-admin-key" };

describe("verifiable receipts end to end", () => {
  let orgId: string;
  let agent: McpSession;
  let receipt: ReceiptDocument;
  let requestId: string;

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Receipt Org",
      agentId: "rcpt-agent",
      approverEmail: "admin@receipts.test",
      policy: POLICY,
    });
    orgId = org.orgId;
    agent = new McpSession(org.apiKey);
    expect(await agent.initialize()).toBe(200);

    // Full Phase-3 story: mandate → purchase → outcome → settlement.
    const keys = await generateIssuerKeypair("Ed25519");
    await SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/issuers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        issuer: ISSUER,
        scheme: "ap2",
        alg: "Ed25519",
        public_key_jwk: keys.publicJwk,
      }),
    });
    const mandate = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({
        iss: ISSUER,
        sub: "rcpt-agent",
        vendors: ["Figma"],
        maxAmountCents: 100_00,
        currency: "USD",
      })
    );
    const purchase = await agent.call("request_purchase", {
      vendor: "Figma",
      amount_cents: 15_00,
      currency: "USD",
      category: "software",
      justification: "receipt testing",
      mandate,
    });
    expect(purchase.status).toBe("approved");
    requestId = purchase.request_id;

    await agent.call("record_outcome", {
      request_id: requestId,
      final_amount_cents: 15_00,
      rail: "card",
      settlement_ref: "AUTH-RCPT",
    });
    await SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/settlements`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        rail: "card",
        auth_code: "AUTH-RCPT",
        merchant: "Figma",
        amount_cents: 15_00,
        currency: "USD",
        posted_at: new Date().toISOString(),
      }),
    });

    receipt = (await agent.call("get_receipt", { request_id: requestId })) as ReceiptDocument;
  });

  it("issues a signed receipt capturing the full chain of the purchase", () => {
    expect(receipt.format).toBe("verispend-receipt");
    const payload = JSON.parse(receipt.payload_json);
    expect(payload.request).toMatchObject({ vendor: "Figma", amount_cents: 15_00 });
    expect(payload.decision).toMatchObject({ status: "completed" });
    expect(payload.mandate).toMatchObject({ issuer: ISSUER, verification_status: "verified" });
    expect(payload.outcome).toMatchObject({
      final_amount_cents: 15_00,
      settlement_rail: "card",
      settlement_ref: "AUTH-RCPT",
    });
    expect(payload.settlement).toMatchObject({
      match_status: "matched",
      match_method: "settlement_ref",
      variance_cents: 0,
    });
    expect(payload.ledger_anchor.events.length).toBeGreaterThanOrEqual(5);
    expect(payload.ledger_anchor.chain_head).toBeTruthy();
  });

  it("verifies independently with zero src/ imports, and detects tampering", async () => {
    expect(await verifyReceipt(receipt as VerifiableReceipt)).toEqual({ ok: true });

    // Any altered byte of the signed payload breaks the signature.
    const tampered = {
      ...receipt,
      payload_json: receipt.payload_json.replace('"amount_cents":1500', '"amount_cents":9500'),
    };
    expect(tampered.payload_json).not.toBe(receipt.payload_json);
    expect(await verifyReceipt(tampered as VerifiableReceipt)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signature"),
    });

    // A swapped public key no longer matches the key_id thumbprint.
    const otherKey = await generateIssuerKeypair("Ed25519");
    const swapped = {
      ...receipt,
      signature: { ...receipt.signature, public_key_jwk: otherKey.publicJwk },
    };
    expect(await verifyReceipt(swapped as VerifiableReceipt)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("key_id"),
    });
  });

  it("cross-checks the receipt's ledger anchors against a verified audit bundle", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/export/audit-bundle.json`,
      { headers: { "x-admin-key": "test-admin-key" } }
    );
    const bundle = await res.json<VerifiableBundle>();
    expect((await verifyBundle(bundle)).ok).toBe(true);

    const anchor = crossCheckAnchor(receipt as VerifiableReceipt, bundle);
    expect(anchor.ok).toBe(true);
    expect(anchor.checked).toBeGreaterThanOrEqual(6);

    // Altering an anchored hash is caught.
    const doctored = {
      ...bundle,
      events: bundle.events.map((e, i) => (i === 1 ? { ...e, hash: "0".repeat(64) } : e)),
    };
    expect(crossCheckAnchor(receipt as VerifiableReceipt, doctored).ok).toBe(false);
  });

  it("returns the same receipt on repeat get_receipt, and records issuance", async () => {
    const again = (await agent.call("get_receipt", { request_id: requestId })) as ReceiptDocument;
    expect(again.receipt_id).toBe(receipt.receipt_id);

    const event = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND request_id = ? AND event_type = 'receipt_issued'"
    )
      .bind(orgId, requestId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      receiptId: receipt.receipt_id,
      issuedBy: "mcp:rcpt-agent",
    });
  });

  it("reissues on demand via the admin API, newest wins", async () => {
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/requests/${requestId}/receipt`,
      { method: "POST", headers: admin, body: "{}" }
    );
    expect(res.status).toBe(200);
    const reissued = await res.json<ReceiptDocument>();
    expect(reissued.receipt_id).not.toBe(receipt.receipt_id);
    expect(await verifyReceipt(reissued as VerifiableReceipt)).toEqual({ ok: true });

    const latest = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/requests/${requestId}/receipt.json`,
      { headers: { "x-admin-key": "test-admin-key" } }
    );
    expect((await latest.json<ReceiptDocument>()).receipt_id).toBe(reissued.receipt_id);
  });

  it("attests denials too, but refuses pending requests", async () => {
    const denied = await agent.call("request_purchase", {
      vendor: "Figma",
      amount_cents: 999_00, // over the per-transaction cap
      currency: "USD",
      category: "software",
      justification: "denied receipt",
    });
    expect(denied.status).toBe("denied");
    const deniedReceipt = await issueReceipt(env, {
      orgId,
      requestId: denied.request_id,
      issuedBy: "test",
    });
    expect(deniedReceipt.ok).toBe(true);
    if (deniedReceipt.ok) {
      const payload = JSON.parse(deniedReceipt.receipt.payload_json);
      expect(payload.decision.status).toBe("denied");
      expect(payload.settlement).toBeNull();
    }

    const pendingOrg = await provisionOrg({
      name: "Pending Receipt Org",
      agentId: "pend-agent",
      approverEmail: "admin@pending-receipts.test",
      policy: { ...POLICY, escalation: { amountCents: 10_00 } },
    });
    const pendingAgent = new McpSession(pendingOrg.apiKey);
    expect(await pendingAgent.initialize()).toBe(200);
    const pending = await pendingAgent.call("request_purchase", {
      vendor: "Figma",
      amount_cents: 20_00,
      currency: "USD",
      category: "software",
      justification: "pending receipt",
    });
    expect(pending.status).toBe("pending_approval");
    const refused = await pendingAgent.call("get_receipt", {
      request_id: pending.request_id,
    });
    expect(refused.error).toContain("pending");
  });

  it("publishes the signing key at /.well-known, matching the receipt's kid", async () => {
    const res = await SELF.fetch("http://example.com/.well-known/verispend-keys.json");
    expect(res.status).toBe(200);
    const { keys } = await res.json<{
      keys: Array<{ kid: string; kty: string; crv: string; x: string }>;
    }>();
    const published = keys.find((k) => k.kid === receipt.signature.key_id);
    expect(published).toBeTruthy();
    expect(published?.x).toBe(receipt.signature.public_key_jwk.x);
    expect(await computeKeyId(published!)).toBe(receipt.signature.key_id);
  });
});
