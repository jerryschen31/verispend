// Simulated mandate issuer: mints the signed payment-mandate credentials
// (compact JWS) that real networks (Google AP2, Visa Verified Agent ID,
// Stripe) will issue in production. Tests and the simulator use it to
// exercise the exact verification path a real credential would take — the
// only difference at runtime is which public key sits in mandate_issuers.
//
// Deliberately imports nothing from src/ (like verify-bundle.ts): a mandate
// is produced by a party that runs zero VeriSpend code.
//
// Usage as CLI: node scripts/test-issuer.ts --keygen [Ed25519|ES256]
// (prints a JWK keypair; the Ed25519 private JWK doubles as a value for the
// RECEIPT_SIGNING_KEY secret).

declare const process: {
  argv: string[];
  exitCode?: number;
};

export type IssuerAlg = "Ed25519" | "ES256";

export type IssuerKeypair = {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
};

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const KEY_PARAMS: Record<IssuerAlg, { name: string; namedCurve?: string }> = {
  Ed25519: { name: "Ed25519" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
};

const SIGN_PARAMS: Record<IssuerAlg, { name: string; hash?: string } | string> = {
  Ed25519: "Ed25519",
  ES256: { name: "ECDSA", hash: "SHA-256" },
};

/** JWS "alg" header value per RFC 7518 / RFC 8037. */
const JWS_ALG: Record<IssuerAlg, string> = { Ed25519: "EdDSA", ES256: "ES256" };

export async function generateIssuerKeypair(alg: IssuerAlg): Promise<IssuerKeypair> {
  const pair = (await crypto.subtle.generateKey(KEY_PARAMS[alg], true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
}

export type MandateClaims = {
  iss: string;
  sub: string;
  jti?: string;
  /** Unix seconds. */
  nbf?: number;
  /** Unix seconds. */
  exp?: number;
  [claim: string]: unknown;
};

/** Sign a set of claims into a compact JWS the way a network issuer would. */
export async function mintMandate(
  privateJwk: JsonWebKey,
  alg: IssuerAlg,
  claims: MandateClaims
): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, KEY_PARAMS[alg], false, [
    "sign",
  ]);
  const header = b64url(enc.encode(JSON.stringify({ alg: JWS_ALG[alg], typ: "JWT" })));
  const payload = b64url(
    enc.encode(JSON.stringify({ jti: `mnd-${crypto.randomUUID()}`, ...claims }))
  );
  const sig = await crypto.subtle.sign(
    SIGN_PARAMS[alg],
    key,
    enc.encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

export type ScopeArgs = {
  vendors?: string[];
  categories?: string[];
  maxAmountCents?: number;
  currency?: string;
};

/** AP2-shaped claims: a structured scope object, like the generic scheme. */
export function ap2Claims(
  args: { iss: string; sub: string; expiresInS?: number } & ScopeArgs
): MandateClaims {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: args.iss,
    sub: args.sub,
    nbf: nowS,
    exp: nowS + (args.expiresInS ?? 3600),
    scope: {
      vendors: args.vendors,
      categories: args.categories,
      max_amount_cents: args.maxAmountCents,
      currency: args.currency,
    },
  };
}

/** Visa-VAI-shaped claims: merchant list and a flat transaction limit. */
export function visaVaiClaims(
  args: { iss: string; sub: string; expiresInS?: number } & ScopeArgs
): MandateClaims {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: args.iss,
    sub: args.sub,
    nbf: nowS,
    exp: nowS + (args.expiresInS ?? 3600),
    merchant_ids: args.vendors,
    categories: args.categories,
    transaction_limit: args.maxAmountCents,
    currency: args.currency,
  };
}

/** Stripe-token-shaped claims: one merchant and an amount ceiling. */
export function stripeTokenClaims(
  args: { iss: string; sub: string; expiresInS?: number } & ScopeArgs
): MandateClaims {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    iss: args.iss,
    sub: args.sub,
    nbf: nowS,
    exp: nowS + (args.expiresInS ?? 3600),
    merchant: args.vendors?.[0],
    amount: args.maxAmountCents,
    currency: args.currency,
  };
}

// CLI entry: print a fresh JWK keypair.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("test-issuer.ts")) {
  if (process.argv[2] !== "--keygen") {
    console.error("Usage: node scripts/test-issuer.ts --keygen [Ed25519|ES256]");
    process.exitCode = 2;
  } else {
    const alg = (process.argv[3] ?? "Ed25519") as IssuerAlg;
    if (alg !== "Ed25519" && alg !== "ES256") {
      console.error("alg must be Ed25519 or ES256");
      process.exitCode = 2;
    } else {
      const pair = await generateIssuerKeypair(alg);
      console.log(JSON.stringify({ alg, ...pair }, null, 2));
    }
  }
}
