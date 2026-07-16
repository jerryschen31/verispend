import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkMandateScope,
  normalizeScope,
  parseCompactJws,
  verifyMandate,
} from "../src/mandate";
import { insertMandateIssuer, revokeMandateIssuer } from "../src/db";
import {
  ap2Claims,
  generateIssuerKeypair,
  mintMandate,
  stripeTokenClaims,
  visaVaiClaims,
  type IssuerKeypair,
} from "../scripts/test-issuer.ts";
import { McpSession, provisionOrg } from "./helpers";
import type { PolicyRules } from "../src/policy";

const ISSUER = "https://issuer.sim.test";
const INTENT = {
  vendor: "Figma",
  amountCents: 15_00,
  currency: "USD",
  category: "software",
};

const registerIssuer = async (
  orgId: string,
  keys: IssuerKeypair,
  opts: { issuer?: string; scheme?: string; alg?: string } = {}
) =>
  insertMandateIssuer(env.DB, {
    orgId,
    issuer: opts.issuer ?? ISSUER,
    scheme: opts.scheme ?? "ap2",
    alg: opts.alg ?? "Ed25519",
    publicKeyJwk: JSON.stringify(keys.publicJwk),
  });

describe("compact JWS parsing", () => {
  it("rejects garbage, wrong segment counts, and bad base64", () => {
    expect(parseCompactJws("not a token")).toBeNull();
    expect(parseCompactJws("a.b")).toBeNull();
    expect(parseCompactJws("a.b.c.d")).toBeNull();
    expect(parseCompactJws("!!!.???.###")).toBeNull();
  });

  it("parses a minted mandate", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: ISSUER, sub: "agent-1", vendors: ["Figma"] })
    );
    const jws = parseCompactJws(token);
    expect(jws?.payload.iss).toBe(ISSUER);
    expect(jws?.payload.sub).toBe("agent-1");
  });
});

describe("scheme claim normalization", () => {
  it("maps visa_vai claims onto the normalized scope", () => {
    const scope = normalizeScope("visa_vai", {
      merchant_ids: ["Figma", "Linear"],
      transaction_limit: 50_00,
      currency: "USD",
    });
    expect(scope).toEqual({
      vendors: ["Figma", "Linear"],
      categories: undefined,
      maxAmountCents: 50_00,
      currency: "USD",
    });
  });

  it("maps stripe_token claims onto the normalized scope", () => {
    const scope = normalizeScope("stripe_token", {
      merchant: "Figma",
      amount: 20_00,
      currency: "USD",
    });
    expect(scope).toEqual({
      vendors: ["Figma"],
      maxAmountCents: 20_00,
      currency: "USD",
    });
  });

  it("reads ap2/generic structured scope and ignores unknown claims", () => {
    const scope = normalizeScope("ap2", {
      scope: { vendors: ["Figma"], max_amount_cents: 10_00 },
      some_future_claim: { anything: true },
    });
    expect(scope).toEqual({
      vendors: ["Figma"],
      categories: undefined,
      maxAmountCents: 10_00,
      currency: undefined,
    });
  });
});

describe("scope and validity checks", () => {
  const at = (iso: string) => new Date(iso);

  it("enforces the validity window with ±60s clock skew", () => {
    const window = {
      scope: {},
      notBefore: "2026-07-15T12:00:00.000Z",
      expiresAt: "2026-07-15T13:00:00.000Z",
    };
    // 59s early: within skew.
    expect(checkMandateScope(window, INTENT, at("2026-07-15T11:59:01.000Z")).ok).toBe(true);
    // 61s early: too early.
    expect(checkMandateScope(window, INTENT, at("2026-07-15T11:58:59.000Z"))).toMatchObject(
      { ok: false, status: "expired" }
    );
    // 59s late: within skew.
    expect(checkMandateScope(window, INTENT, at("2026-07-15T13:00:59.000Z")).ok).toBe(true);
    // 61s late: expired.
    expect(checkMandateScope(window, INTENT, at("2026-07-15T13:01:01.000Z"))).toMatchObject(
      { ok: false, status: "expired" }
    );
  });

  it("flags each scope violation with a plain-language reason", () => {
    const now = new Date();
    const base = { notBefore: null, expiresAt: null };
    expect(
      checkMandateScope({ ...base, scope: { vendors: ["Linear"] } }, INTENT, now)
    ).toMatchObject({ ok: false, status: "scope_violation" });
    expect(
      checkMandateScope({ ...base, scope: { categories: ["travel"] } }, INTENT, now)
    ).toMatchObject({ ok: false, status: "scope_violation" });
    expect(
      checkMandateScope({ ...base, scope: { maxAmountCents: 10_00 } }, INTENT, now)
    ).toMatchObject({ ok: false, status: "scope_violation" });
    expect(
      checkMandateScope({ ...base, scope: { currency: "EUR" } }, INTENT, now)
    ).toMatchObject({ ok: false, status: "scope_violation" });
    // Vendor matching uses policy-style trim/lowercase semantics.
    expect(
      checkMandateScope({ ...base, scope: { vendors: ["  FIGMA "] } }, INTENT, now).ok
    ).toBe(true);
  });
});

describe("verifyMandate against the trusted-issuer registry", () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await provisionOrg({ name: "Mandate Unit Org", agentId: "mu-agent" });
    orgId = org.orgId;
  });

  it("verifies an Ed25519 mandate from a registered issuer", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    await registerIssuer(orgId, keys, { issuer: `${ISSUER}/ed` });
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: `${ISSUER}/ed`, sub: "agent-1", vendors: ["Figma"], maxAmountCents: 20_00 })
    );
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result.ok).toBe(true);
    expect(result.presentation.status).toBe("verified");
    expect(result.presentation.scheme).toBe("ap2");
    expect(result.trace[0]).toMatchObject({ rule: "mandate_ok", result: "pass" });
  });

  it("verifies an ES256 mandate from a registered issuer", async () => {
    const keys = await generateIssuerKeypair("ES256");
    await registerIssuer(orgId, keys, { issuer: `${ISSUER}/es`, alg: "ES256", scheme: "visa_vai" });
    const token = await mintMandate(
      keys.privateJwk,
      "ES256",
      visaVaiClaims({ iss: `${ISSUER}/es`, sub: "agent-1", vendors: ["Figma"], maxAmountCents: 20_00 })
    );
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result.ok).toBe(true);
    expect(result.presentation.scheme).toBe("visa_vai");
  });

  it("rejects a mandate from an unregistered issuer", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: "https://nobody.test", sub: "agent-1" })
    );
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result).toMatchObject({
      ok: false,
      ruleFired: "mandate_issuer_unknown",
    });
    expect(result.presentation.status).toBe("issuer_unknown");
  });

  it("rejects a mandate signed by the wrong key", async () => {
    const registered = await generateIssuerKeypair("Ed25519");
    const attacker = await generateIssuerKeypair("Ed25519");
    await registerIssuer(orgId, registered, { issuer: `${ISSUER}/wrongkey` });
    const token = await mintMandate(
      attacker.privateJwk,
      "Ed25519",
      ap2Claims({ iss: `${ISSUER}/wrongkey`, sub: "agent-1", vendors: ["Figma"] })
    );
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result).toMatchObject({ ok: false, ruleFired: "mandate_invalid" });
  });

  it("pins the algorithm to the registration, not the JWS header", async () => {
    // Issuer registered as Ed25519; token signed with ES256. Even with a
    // valid ES256 signature and an honest header, verification must fail.
    const es = await generateIssuerKeypair("ES256");
    await insertMandateIssuer(env.DB, {
      orgId,
      issuer: `${ISSUER}/pinned`,
      scheme: "ap2",
      alg: "Ed25519",
      publicKeyJwk: JSON.stringify(es.publicJwk),
    });
    const token = await mintMandate(
      es.privateJwk,
      "ES256",
      ap2Claims({ iss: `${ISSUER}/pinned`, sub: "agent-1", vendors: ["Figma"] })
    );
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result).toMatchObject({ ok: false, ruleFired: "mandate_invalid" });
  });

  it("rejects an expired mandate and one violating scope", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    await registerIssuer(orgId, keys, { issuer: `${ISSUER}/window` });
    const expired = await mintMandate(keys.privateJwk, "Ed25519", {
      ...ap2Claims({ iss: `${ISSUER}/window`, sub: "agent-1", vendors: ["Figma"] }),
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(await verifyMandate(env.DB, orgId, expired, INTENT)).toMatchObject({
      ok: false,
      ruleFired: "mandate_expired",
    });

    const wrongVendor = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: `${ISSUER}/window`, sub: "agent-1", vendors: ["Linear"] })
    );
    expect(await verifyMandate(env.DB, orgId, wrongVendor, INTENT)).toMatchObject({
      ok: false,
      ruleFired: "mandate_scope_violation",
    });
  });

  it("trims whitespace-padded claims before storing or reporting them", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    await registerIssuer(orgId, keys, { issuer: `${ISSUER}/trim` });
    const token = await mintMandate(keys.privateJwk, "Ed25519", {
      ...ap2Claims({ iss: `${ISSUER}/trim`, sub: "agent-1", vendors: ["Figma"] }),
      // Padded claims must not leak whitespace into stored/audited values.
      iss: `  ${ISSUER}/trim  `,
      sub: "  agent-1  ",
      jti: "  mnd-padded  ",
    });
    const result = await verifyMandate(env.DB, orgId, token, INTENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presentation.issuer).toBe(`${ISSUER}/trim`);
      expect(result.presentation.subject).toBe("agent-1");
      expect(result.presentation.mandateRef).toBe("mnd-padded");
    }
  });

  it("accepts a JWK registered with optional fields (Node-style full export)", async () => {
    // Node's exportKey emits alg "Ed25519" / key_ops / ext, which some
    // runtimes reject at importKey; registration must tolerate a full paste.
    const keys = await generateIssuerKeypair("Ed25519");
    await insertMandateIssuer(env.DB, {
      orgId,
      issuer: `${ISSUER}/fulljwk`,
      scheme: "ap2",
      alg: "Ed25519",
      publicKeyJwk: JSON.stringify({
        ...keys.publicJwk,
        alg: "Ed25519",
        key_ops: ["verify"],
        ext: true,
      }),
    });
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: `${ISSUER}/fulljwk`, sub: "agent-1", vendors: ["Figma"] })
    );
    expect((await verifyMandate(env.DB, orgId, token, INTENT)).ok).toBe(true);
  });

  it("rejects mandates from a revoked issuer, then accepts after re-registration", async () => {
    const keys = await generateIssuerKeypair("Ed25519");
    const { issuerId } = await registerIssuer(orgId, keys, { issuer: `${ISSUER}/rev` });
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: `${ISSUER}/rev`, sub: "agent-1", vendors: ["Figma"] })
    );
    expect((await verifyMandate(env.DB, orgId, token, INTENT)).ok).toBe(true);

    await revokeMandateIssuer(env.DB, orgId, issuerId);
    expect(await verifyMandate(env.DB, orgId, token, INTENT)).toMatchObject({
      ok: false,
      ruleFired: "mandate_issuer_unknown",
    });

    // Re-registering the same issuer name reactivates it (key rotation path).
    await registerIssuer(orgId, keys, { issuer: `${ISSUER}/rev` });
    expect((await verifyMandate(env.DB, orgId, token, INTENT)).ok).toBe(true);
  });
});

describe("mandates through the MCP purchase flow", () => {
  const POLICY: PolicyRules = {
    currency: "USD",
    maxPerTransactionCents: 500_00,
    budgets: { perAgent: { dailyCents: 1000_00 } },
    mandates: { require: { amountCentsAtLeast: 100_00 } },
  };

  let orgId: string;
  let agent: McpSession;
  let keys: IssuerKeypair;

  const buy = (amountCents: number, mandate?: string) =>
    agent.call("request_purchase", {
      vendor: "Figma",
      amount_cents: amountCents,
      currency: "USD",
      category: "software",
      justification: "mandate flow testing",
      ...(mandate !== undefined ? { mandate } : {}),
    });

  beforeAll(async () => {
    const org = await provisionOrg({
      name: "Mandate Flow Org",
      agentId: "mf-agent",
      approverEmail: "admin@mandate.test",
      policy: POLICY,
    });
    orgId = org.orgId;
    agent = new McpSession(org.apiKey);
    expect(await agent.initialize()).toBe(200);

    keys = await generateIssuerKeypair("Ed25519");
    const res = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/issuers`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-key": "test-admin-key",
        },
        body: JSON.stringify({
          issuer: ISSUER,
          scheme: "ap2",
          alg: "Ed25519",
          public_key_jwk: keys.publicJwk,
        }),
      }
    );
    expect(res.status).toBe(200);
  });

  it("approves a mandated purchase, records the mandate, and explains it", async () => {
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({
        iss: ISSUER,
        sub: "mf-agent",
        vendors: ["Figma"],
        maxAmountCents: 200_00,
        currency: "USD",
      })
    );
    const res = await buy(150_00, token);
    expect(res.status).toBe("approved");
    expect(res.mandate).toMatchObject({ status: "verified", scheme: "ap2", issuer: ISSUER });
    expect(
      res.trace.find((t: { rule: string }) => t.rule === "mandate_ok")
    ).toMatchObject({ result: "pass" });
    expect(
      res.trace.find((t: { rule: string }) => t.rule === "mandate_missing")
    ).toMatchObject({ result: "pass" });

    const mandateRow = await env.DB.prepare(
      "SELECT * FROM payment_mandates WHERE org_id = ? AND request_id = ?"
    )
      .bind(orgId, res.request_id)
      .first<{ verification_status: string; issuer: string; raw_token: string }>();
    expect(mandateRow).toMatchObject({
      verification_status: "verified",
      issuer: ISSUER,
      raw_token: token,
    });

    const event = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND request_id = ? AND event_type = 'mandate_verified'"
    )
      .bind(orgId, res.request_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      issuer: ISSUER,
      status: "verified",
    });
  });

  it("denies a purchase that requires a mandate when none is presented", async () => {
    const res = await buy(120_00);
    expect(res.status).toBe("denied");
    expect(res.rule_fired).toBe("mandate_missing");
    expect(res.reason).toContain("requires a verified payment mandate");
  });

  it("does not require a mandate below the threshold", async () => {
    const res = await buy(50_00);
    expect(res.status).toBe("approved");
    expect(
      res.trace.find((t: { rule: string }) => t.rule === "mandate_missing")
    ).toMatchObject({ result: "pass" });
  });

  it("hard-denies a tampered mandate and records the rejection", async () => {
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: ISSUER, sub: "mf-agent", vendors: ["Figma"], maxAmountCents: 200_00 })
    );
    // Flip the amount inside the signed payload: signature must break.
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(atob(p.replaceAll("-", "+").replaceAll("_", "/")));
    payload.scope.max_amount_cents = 999_999_00;
    const forgedPayload = btoa(JSON.stringify(payload))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const res = await buy(20_00, `${h}.${forgedPayload}.${s}`);
    expect(res.status).toBe("denied");
    expect(res.rule_fired).toBe("mandate_invalid");
    expect(res.mandate).toMatchObject({ status: "invalid" });

    const event = await env.DB.prepare(
      "SELECT payload_json FROM ledger_events WHERE org_id = ? AND request_id = ? AND event_type = 'mandate_rejected'"
    )
      .bind(orgId, res.request_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(event!.payload_json)).toMatchObject({ status: "invalid" });
  });

  it("denies an out-of-scope mandate even below the require threshold", async () => {
    const token = await mintMandate(
      keys.privateJwk,
      "Ed25519",
      ap2Claims({ iss: ISSUER, sub: "mf-agent", vendors: ["Linear"], maxAmountCents: 200_00 })
    );
    const res = await buy(20_00, token);
    expect(res.status).toBe("denied");
    expect(res.rule_fired).toBe("mandate_scope_violation");
  });

  it("validates issuer registration inputs on the admin API", async () => {
    const post = (body: unknown) =>
      SELF.fetch(`http://example.com/api/admin/orgs/${orgId}/issuers`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-key": "test-admin-key",
        },
        body: JSON.stringify(body),
      });
    expect((await post({ scheme: "ap2", alg: "Ed25519", public_key_jwk: {} })).status).toBe(400);
    expect(
      (await post({ issuer: "x", scheme: "nope", alg: "Ed25519", public_key_jwk: {} })).status
    ).toBe(400);
    expect(
      (await post({ issuer: "x", scheme: "ap2", alg: "RS256", public_key_jwk: {} })).status
    ).toBe(400);
    expect(
      (await post({ issuer: "x", scheme: "ap2", alg: "Ed25519", public_key_jwk: "str" })).status
    ).toBe(400);

    const noKey = await SELF.fetch(
      `http://example.com/api/admin/orgs/${orgId}/issuers`,
      { method: "POST", body: "{}" }
    );
    expect(noKey.status).toBe(401);
  });
});
