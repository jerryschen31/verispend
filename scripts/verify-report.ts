// Independent verifier for a VeriSpend compliance report.
//
// Deliberately does NOT import src/: an auditor re-verifies the report from
// the recipe embedded in it, with nothing but Node and this file. Optionally
// cross-checks the report's ledger anchors against an audit bundle (itself
// verifiable with verify-bundle.ts), proving the report describes the same
// chain the org exported.
//
// Usage: node scripts/verify-report.ts <report.json> [bundle.json]

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

export type VerifiableReport = {
  format: string;
  version: number;
  report_id: string;
  issued_at: string;
  payload_json: string;
  signature: {
    alg: string;
    key_id: string;
    public_key_jwk: JsonWebKey;
    sig: string;
  };
};

export type ReportVerification = { ok: boolean; reason?: string };

export async function verifyReport(
  report: VerifiableReport
): Promise<ReportVerification> {
  if (report.format !== "verispend-compliance-report") {
    return { ok: false, reason: `unexpected format "${report.format}"` };
  }
  if (report.signature.alg !== "Ed25519") {
    return { ok: false, reason: `unexpected algorithm "${report.signature.alg}"` };
  }

  // The key_id must be the thumbprint of the embedded public key; a swapped
  // key would produce a different id than the one published in /.well-known.
  const jwk = report.signature.public_key_jwk;
  const expectedKeyId = (
    await sha256Hex(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  ).slice(0, 16);
  if (expectedKeyId !== report.signature.key_id) {
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
    b64urlDecode(report.signature.sig),
    new TextEncoder().encode(report.payload_json)
  );
  if (!valid) {
    return { ok: false, reason: "signature does not verify (payload was altered)" };
  }

  const payload = JSON.parse(report.payload_json) as { report_id?: string };
  if (payload.report_id !== report.report_id) {
    return { ok: false, reason: "payload report_id does not match the envelope" };
  }
  return { ok: true };
}

type AnchoredPayload = {
  ledger_anchor?: {
    first_event: { seq: number; hash: string } | null;
    last_event: { seq: number; hash: string } | null;
    chain_head: { seq: number; hash: string } | null;
  };
};

type AnchorBundle = {
  events: Array<{ seq: number; hash: string }>;
};

export type ReportAnchorCheck = {
  ok: boolean;
  checked: number;
  reason?: string;
};

/** Confirm the report's anchored hashes exist, unaltered, in the bundle's
 * (independently verified) chain. */
export function crossCheckReportAnchor(
  report: VerifiableReport,
  bundle: AnchorBundle
): ReportAnchorCheck {
  const payload = JSON.parse(report.payload_json) as AnchoredPayload;
  const anchor = payload.ledger_anchor;
  if (!anchor) return { ok: false, checked: 0, reason: "report has no ledger anchor" };

  const bySeq = new Map(bundle.events.map((e) => [e.seq, e.hash]));
  const toCheck = [anchor.first_event, anchor.last_event, anchor.chain_head].filter(
    (e): e is { seq: number; hash: string } => e !== null
  );
  if (toCheck.length === 0) {
    return { ok: false, checked: 0, reason: "report anchors no events" };
  }
  const missing = toCheck.filter((e) => bySeq.get(e.seq) !== e.hash);
  if (missing.length > 0) {
    return {
      ok: false,
      checked: toCheck.length,
      reason: "anchored hashes are absent from or altered in the bundle chain",
    };
  }
  return { ok: true, checked: toCheck.length };
}

// CLI entry: verify a downloaded report, optionally against a bundle.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("verify-report.ts")) {
  const [reportPath, bundlePath] = process.argv.slice(2);
  if (!reportPath) {
    console.error("Usage: node scripts/verify-report.ts <report.json> [bundle.json]");
    process.exitCode = 2;
  } else {
    const { readFileSync } = await import("node:fs");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as VerifiableReport;
    const result = await verifyReport(report);
    if (!result.ok) {
      console.error(`✘ report invalid: ${result.reason}`);
      process.exitCode = 1;
    } else {
      const p = JSON.parse(report.payload_json) as {
        org: { name: string };
        period: { start: string | null; end: string | null };
        chain_verification: { ok: boolean; count?: number };
        frameworks: Array<{
          id: string;
          summary: Record<string, number>;
          controls: Array<{ control_id: string; status: string }>;
        }>;
        exceptions: Record<string, unknown[]>;
      };
      console.log(`✔ signature verified (key ${report.signature.key_id})`);
      console.log(
        `  ${p.org.name} — period ${p.period.start ?? "genesis"} → ${p.period.end ?? "now"}, ` +
          `chain ${p.chain_verification.ok ? `verified (${p.chain_verification.count} events)` : "BROKEN"}`
      );
      for (const fw of p.frameworks) {
        const s = fw.summary;
        console.log(
          `  ${fw.id}: ${fw.controls.length} controls — ` +
            `${s.evidenced ?? 0} evidenced, ${s.attention ?? 0} attention, ` +
            `${s.no_activity ?? 0} no activity`
        );
      }
      if (bundlePath) {
        const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as AnchorBundle;
        const anchor = crossCheckReportAnchor(report, bundle);
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
