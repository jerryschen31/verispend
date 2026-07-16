// Payment-mandate verification (Phase 3). A mandate is a signed, scoped,
// time-limited permission slip issued by a payment network (Google AP2, Visa
// Verified Agent ID, Stripe tokens) and presented by an agent alongside a
// purchase request. VeriSpend consumes these credentials; it never issues
// them (Rule 2). Verification is pure local crypto against a public key the
// org registered in mandate_issuers — no network calls, ever.
//
// Wire format: compact JWS (base64url(header).base64url(payload).base64url(sig)).
// Scheme differences are confined to small claim normalizers so a spec change
// upstream is a mapping edit, not a redesign.

import { b64urlDecode, sha256Hex } from "./hash";
import { getMandateIssuer, type MandateIssuerRow } from "./db";
import { norm, type PurchaseIntent, type TraceEntry } from "./policy";

export const MANDATE_SCHEMES = ["ap2", "visa_vai", "stripe_token", "generic"] as const;
export type MandateScheme = (typeof MANDATE_SCHEMES)[number];

export const MANDATE_ALGS = ["Ed25519", "ES256"] as const;
export type MandateAlg = (typeof MANDATE_ALGS)[number];

/** Allowance for clock drift between issuer and VeriSpend, in seconds. */
const CLOCK_SKEW_S = 60;

export type MandateScope = {
  vendors?: string[];
  categories?: string[];
  maxAmountCents?: number;
  currency?: string;
};

export type MandateFailRule =
  | "mandate_invalid"
  | "mandate_expired"
  | "mandate_scope_violation"
  | "mandate_issuer_unknown";

export type MandateStatus =
  | "verified"
  | "invalid"
  | "expired"
  | "scope_violation"
  | "issuer_unknown";

/**
 * Best-effort record of a presentation, persisted whether or not the mandate
 * verified — a rejected credential is audit evidence too. Fields fall back to
 * "unknown" when the token is too malformed to parse.
 */
export type MandatePresentation = {
  issuerId: string | null;
  scheme: string;
  issuer: string;
  subject: string;
  mandateRef: string;
  scope: MandateScope;
  notBefore: string | null;
  expiresAt: string | null;
  tokenHash: string;
  status: MandateStatus;
};

export type MandateVerification =
  | { ok: true; presentation: MandatePresentation; trace: TraceEntry[] }
  | {
      ok: false;
      ruleFired: MandateFailRule;
      reason: string;
      presentation: MandatePresentation;
      trace: TraceEntry[];
    };

type ParsedJws = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signedBytes: Uint8Array;
  signatureBytes: Uint8Array;
};

export function parseCompactJws(token: string): ParsedJws | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof header !== "object" || header === null) return null;
    if (typeof payload !== "object" || payload === null) return null;
    return {
      header,
      payload,
      signedBytes: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signatureBytes: b64urlDecode(parts[2]),
    };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string")
    ? (v as string[])
    : undefined;

/**
 * Map a scheme's claim names onto the one normalized scope VeriSpend
 * evaluates. Unknown claims are ignored so upstream spec additions don't
 * break verification.
 */
export function normalizeScope(
  scheme: string,
  payload: Record<string, unknown>
): MandateScope {
  if (scheme === "visa_vai") {
    return {
      vendors: strList(payload.merchant_ids),
      categories: strList(payload.categories),
      maxAmountCents: int(payload.transaction_limit),
      currency: str(payload.currency),
    };
  }
  if (scheme === "stripe_token") {
    const merchant = str(payload.merchant);
    return {
      vendors: merchant ? [merchant] : undefined,
      maxAmountCents: int(payload.amount),
      currency: str(payload.currency),
    };
  }
  // "ap2" and "generic" carry a structured scope claim directly.
  const scope =
    typeof payload.scope === "object" && payload.scope !== null
      ? (payload.scope as Record<string, unknown>)
      : {};
  return {
    vendors: strList(scope.vendors),
    categories: strList(scope.categories),
    maxAmountCents: int(scope.max_amount_cents),
    currency: str(scope.currency),
  };
}

const unixToIso = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v)
    ? new Date(v * 1000).toISOString()
    : null;

/** Scope and validity-window checks; pure so they unit-test in isolation. */
export function checkMandateScope(
  args: {
    scope: MandateScope;
    notBefore: string | null;
    expiresAt: string | null;
  },
  intent: Pick<PurchaseIntent, "vendor" | "amountCents" | "currency" | "category">,
  now: Date
): { ok: true } | { ok: false; status: "expired" | "scope_violation"; reason: string } {
  const nowMs = now.getTime();
  if (args.notBefore && nowMs < Date.parse(args.notBefore) - CLOCK_SKEW_S * 1000) {
    return {
      ok: false,
      status: "expired",
      reason: `Mandate is not valid until ${args.notBefore}.`,
    };
  }
  if (args.expiresAt && nowMs > Date.parse(args.expiresAt) + CLOCK_SKEW_S * 1000) {
    return {
      ok: false,
      status: "expired",
      reason: `Mandate expired at ${args.expiresAt}.`,
    };
  }
  const { scope } = args;
  if (scope.vendors && !scope.vendors.some((v) => norm(v) === norm(intent.vendor))) {
    return {
      ok: false,
      status: "scope_violation",
      reason: `Mandate does not cover vendor "${intent.vendor}".`,
    };
  }
  if (
    scope.categories &&
    !scope.categories.some((c) => norm(c) === norm(intent.category))
  ) {
    return {
      ok: false,
      status: "scope_violation",
      reason: `Mandate does not cover category "${intent.category}".`,
    };
  }
  if (scope.maxAmountCents !== undefined && intent.amountCents > scope.maxAmountCents) {
    return {
      ok: false,
      status: "scope_violation",
      reason: `Amount ${intent.amountCents}¢ exceeds the mandate's limit of ${scope.maxAmountCents}¢.`,
    };
  }
  if (scope.currency && norm(scope.currency) !== norm(intent.currency)) {
    return {
      ok: false,
      status: "scope_violation",
      reason: `Mandate is denominated in ${scope.currency}; purchase is in ${intent.currency}.`,
    };
  }
  return { ok: true };
}

async function verifySignature(
  issuer: MandateIssuerRow,
  jws: ParsedJws
): Promise<boolean> {
  // The algorithm is pinned on the issuer registration, never read from the
  // JWS header — a forged header can't downgrade or confuse verification.
  try {
    const jwk = JSON.parse(issuer.public_key_jwk) as JsonWebKey;
    if (issuer.alg === "Ed25519") {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
        "verify",
      ]);
      return crypto.subtle.verify("Ed25519", key, jws.signatureBytes, jws.signedBytes);
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      jws.signatureBytes,
      jws.signedBytes
    );
  } catch {
    return false;
  }
}

const FAIL_RULE: Record<Exclude<MandateStatus, "verified">, MandateFailRule> = {
  invalid: "mandate_invalid",
  expired: "mandate_expired",
  scope_violation: "mandate_scope_violation",
  issuer_unknown: "mandate_issuer_unknown",
};

export async function verifyMandate(
  db: D1Database,
  orgId: string,
  token: string,
  intent: Pick<PurchaseIntent, "vendor" | "amountCents" | "currency" | "category">,
  now: Date = new Date()
): Promise<MandateVerification> {
  const tokenHash = await sha256Hex(token);
  const presentation: MandatePresentation = {
    issuerId: null,
    scheme: "unknown",
    issuer: "unknown",
    subject: "unknown",
    mandateRef: "unknown",
    scope: {},
    notBefore: null,
    expiresAt: null,
    tokenHash,
    status: "invalid",
  };
  const fail = (
    status: Exclude<MandateStatus, "verified">,
    reason: string
  ): MandateVerification => {
    const ruleFired = FAIL_RULE[status];
    presentation.status = status;
    return {
      ok: false,
      ruleFired,
      reason,
      presentation,
      trace: [{ rule: ruleFired, result: "triggered", detail: reason }],
    };
  };

  const jws = parseCompactJws(token);
  if (!jws) {
    return fail("invalid", "Mandate is not a well-formed signed credential (compact JWS).");
  }
  presentation.issuer = str(jws.payload.iss) ?? "unknown";
  presentation.subject = str(jws.payload.sub) ?? "unknown";
  presentation.mandateRef = str(jws.payload.jti) ?? "unknown";
  presentation.notBefore = unixToIso(jws.payload.nbf);
  presentation.expiresAt = unixToIso(jws.payload.exp);

  if (presentation.issuer === "unknown") {
    return fail("invalid", "Mandate has no issuer (iss) claim.");
  }
  const issuer = await getMandateIssuer(db, orgId, presentation.issuer);
  if (!issuer) {
    return fail(
      "issuer_unknown",
      `Mandate issuer "${presentation.issuer}" is not in this org's trusted-issuer registry (or was revoked).`
    );
  }
  presentation.issuerId = issuer.id;
  presentation.scheme = issuer.scheme;
  presentation.scope = normalizeScope(issuer.scheme, jws.payload);

  if (!(await verifySignature(issuer, jws))) {
    return fail(
      "invalid",
      `Mandate signature does not verify against the registered ${issuer.alg} key for "${issuer.issuer}".`
    );
  }

  const check = checkMandateScope(presentation, intent, now);
  if (!check.ok) {
    return fail(check.status, check.reason);
  }

  presentation.status = "verified";
  const limit =
    presentation.scope.maxAmountCents !== undefined
      ? ` up to ${presentation.scope.maxAmountCents}¢`
      : "";
  const until = presentation.expiresAt ? ` until ${presentation.expiresAt}` : "";
  return {
    ok: true,
    presentation,
    trace: [
      {
        rule: "mandate_ok",
        result: "pass",
        detail: `mandate ${presentation.mandateRef} from ${presentation.issuer} (${issuer.scheme}) covers this purchase${limit}${until}`,
      },
    ],
  };
}
