// Independent verifier for a VeriSpend verifiable receipt.
//
// Deliberately does NOT import src/: a card issuer, auditor, or counterparty
// re-verifies the receipt from the recipe embedded in it, with nothing but
// Node and this file. Optionally cross-checks the receipt's ledger anchors
// against an audit bundle (itself verifiable with verify-bundle.ts), proving
// the receipt's claims are the same ones in the tamper-evident chain.
//
// Usage: node scripts/verify-receipt.ts <receipt.json> [bundle.json]

declare const process: {
  argv: string[];
  exitCode?: number;
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function b64urlDecode(value: string): Uint8Array {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  // atob() requires padded base64; base64url signatures are conventionally
  // unpadded, so restore the "=" padding before decoding.
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export type VerifiableReceipt = {
  format: string;
  version: number;
  receipt_id: string;
  issued_at: string;
  payload_json: string;
  signature: {
    alg: string;
    key_id: string;
    public_key_jwk: JsonWebKey;
    sig: string;
  };
};

export type ReceiptVerification = { ok: boolean; reason?: string };

export async function verifyReceipt(
  receipt: VerifiableReceipt
): Promise<ReceiptVerification> {
  if (receipt.format !== "verispend-receipt") {
    return { ok: false, reason: `unexpected format "${receipt.format}"` };
  }
  if (receipt.signature.alg !== "Ed25519") {
    return { ok: false, reason: `unexpected algorithm "${receipt.signature.alg}"` };
  }

  // The key_id must be the thumbprint of the embedded public key; a swapped
  // key would produce a different id than the one published in /.well-known.
  const jwk = receipt.signature.public_key_jwk;
  const expectedKeyId = (
    await sha256Hex(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  ).slice(0, 16);
  if (expectedKeyId !== receipt.signature.key_id) {
    return { ok: false, reason: "key_id does not match the embedded public key" };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
  } catch {
    return { ok: false, reason: "public_key_jwk is not a valid Ed25519 key" };
  }
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    b64urlDecode(receipt.signature.sig),
    new TextEncoder().encode(receipt.payload_json)
  );
  if (!valid) {
    return { ok: false, reason: "signature does not verify (payload was altered)" };
  }

  const payload = JSON.parse(receipt.payload_json) as { receipt_id?: string };
  if (payload.receipt_id !== receipt.receipt_id) {
    return { ok: false, reason: "payload receipt_id does not match the envelope" };
  }
  return { ok: true };
}

type AnchoredPayload = {
  ledger_anchor?: {
    events: Array<{ seq: number; event_type: string; hash: string }>;
    chain_head: { seq: number; hash: string } | null;
  };
};

type AnchorBundle = {
  events: Array<{ seq: number; hash: string; event_type: string }>;
};

export type AnchorCheck = {
  ok: boolean;
  checked: number;
  missing?: Array<{ seq: number; event_type: string }>;
  reason?: string;
};

/** Confirm every hash the receipt anchors exists, unaltered, in the bundle's
 * (independently verified) chain. */
export function crossCheckAnchor(
  receipt: VerifiableReceipt,
  bundle: AnchorBundle
): AnchorCheck {
  const payload = JSON.parse(receipt.payload_json) as AnchoredPayload;
  const anchor = payload.ledger_anchor;
  if (!anchor) return { ok: false, checked: 0, reason: "receipt has no ledger anchor" };

  const bySeq = new Map(bundle.events.map((e) => [e.seq, e.hash]));
  const toCheck = [
    ...anchor.events,
    ...(anchor.chain_head
      ? [{ ...anchor.chain_head, event_type: "chain_head" }]
      : []),
  ];
  const missing = toCheck.filter((e) => bySeq.get(e.seq) !== e.hash);
  if (missing.length > 0) {
    return {
      ok: false,
      checked: toCheck.length,
      missing: missing.map(({ seq, event_type }) => ({ seq, event_type })),
      reason: "anchored hashes are absent from or altered in the bundle chain",
    };
  }
  return { ok: true, checked: toCheck.length };
}

// CLI entry: verify a downloaded receipt, optionally against a bundle.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("verify-receipt.ts")) {
  const [receiptPath, bundlePath] = process.argv.slice(2);
  if (!receiptPath) {
    console.error("Usage: node scripts/verify-receipt.ts <receipt.json> [bundle.json]");
    process.exitCode = 2;
  } else {
    const { readFileSync } = await import("node:fs");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as VerifiableReceipt;
    const result = await verifyReceipt(receipt);
    if (!result.ok) {
      console.error(`✘ receipt invalid: ${result.reason}`);
      process.exitCode = 1;
    } else {
      const p = JSON.parse(receipt.payload_json) as {
        org: { name: string };
        request: { id: string; vendor: string; amount_cents: number; currency: string; agent_id: string };
        decision: { status: string; rule_fired: string | null; policy_version: number; approver: string | null };
        mandate: { mandate_ref: string; issuer: string } | null;
        settlement: { rail: string; settlement_ref: string; variance_cents: number; match_status: string } | null;
      };
      console.log(`✔ signature verified (key ${receipt.signature.key_id})`);
      console.log(
        `  ${p.org.name}: agent ${p.request.agent_id} purchase ${p.request.id} — ` +
          `${p.request.amount_cents}¢ at ${p.request.vendor} → ${p.decision.status} ` +
          `(rule ${p.decision.rule_fired}, policy v${p.decision.policy_version}` +
          `${p.decision.approver ? `, approved by ${p.decision.approver}` : ""})`
      );
      if (p.mandate) {
        console.log(`  mandate ${p.mandate.mandate_ref} from ${p.mandate.issuer}`);
      }
      if (p.settlement) {
        console.log(
          `  settled via ${p.settlement.rail} ref ${p.settlement.settlement_ref}: ` +
            `${p.settlement.match_status}, variance ${p.settlement.variance_cents}¢`
        );
      }
      if (bundlePath) {
        const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as AnchorBundle;
        const anchor = crossCheckAnchor(receipt, bundle);
        if (anchor.ok) {
          console.log(`✔ ${anchor.checked} ledger anchors confirmed in the bundle chain`);
        } else {
          console.error(`✘ anchor check failed: ${anchor.reason}`);
          process.exitCode = 1;
        }
      }
    }
  }
}
