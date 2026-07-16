// Independent verifier for a VeriSpend audit bundle.
//
// Deliberately does NOT import src/ledger.ts: the point is that an auditor
// (or CI) can re-verify the chain from the recipe embedded in the bundle,
// with nothing but Node and this ~60-line file.
//
// Usage: node scripts/verify-bundle.ts <bundle.json>

// Runs under plain Node (like simulate.ts) but typechecks against workers
// types; process is declared locally instead of adding @types/node, and
// hashing uses Web Crypto, which both runtimes provide.
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

type BundleEvent = {
  seq: number;
  request_id: string;
  event_type: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  created_at: string;
};

export type VerifiableBundle = {
  format: string;
  org: { id: string };
  hash_recipe: {
    algorithm: string;
    genesis_prev_hash: string;
    input_fields: string[];
    separator: string;
  };
  events: BundleEvent[];
};

export type BundleVerification = {
  ok: boolean;
  count: number;
  brokenAtSeq?: number;
  reason?: string;
};

export async function verifyBundle(
  bundle: VerifiableBundle
): Promise<BundleVerification> {
  const { hash_recipe: recipe, events, org } = bundle;
  let expectedPrev = recipe.genesis_prev_hash;

  for (const event of events) {
    if (event.prev_hash !== expectedPrev) {
      return {
        ok: false,
        count: events.length,
        brokenAtSeq: event.seq,
        reason: "prev_hash does not match the preceding event's hash",
      };
    }
    // Fields per the recipe; org_id comes from the bundle's org block.
    const values: Record<string, string> = {
      prev_hash: event.prev_hash,
      org_id: org.id,
      request_id: event.request_id,
      event_type: event.event_type,
      payload_json: event.payload_json,
      created_at: event.created_at,
    };
    const input = recipe.input_fields
      .map((f) => values[f])
      .join(recipe.separator);
    const recomputed = await sha256Hex(input);
    if (recomputed !== event.hash) {
      return {
        ok: false,
        count: events.length,
        brokenAtSeq: event.seq,
        reason: "stored hash does not match recomputed hash (row was altered)",
      };
    }
    expectedPrev = event.hash;
  }
  return { ok: true, count: events.length };
}

// CLI entry: verify a downloaded bundle file.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("verify-bundle.ts")) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/verify-bundle.ts <bundle.json>");
    process.exitCode = 2;
  } else {
    const { readFileSync } = await import("node:fs");
    const bundle = JSON.parse(readFileSync(path, "utf8")) as VerifiableBundle;
    const result = await verifyBundle(bundle);
    if (result.ok) {
      console.log(`✔ chain verified: ${result.count} events, none altered`);
    } else {
      console.error(
        `✘ chain broken at seq ${result.brokenAtSeq}: ${result.reason}`
      );
      process.exitCode = 1;
    }
  }
}
