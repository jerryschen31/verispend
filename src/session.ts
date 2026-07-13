// HMAC-signed tokens for magic-link login and dashboard sessions.
// Format: base64url(payload-json) + "." + base64url(hmac-sha256(payload)).

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function b64urlDecode(value: string): Uint8Array {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export type TokenPayload = {
  /** Only dashboard session cookies for now; Kinde handles login itself. */
  purpose: "session";
  email: string;
  orgId: string;
  /** Unix ms expiry. */
  exp: number;
};

export async function signToken(
  secret: string,
  payload: TokenPayload
): Promise<string> {
  const body = enc.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), body);
  return `${b64url(body)}.${b64url(sig)}`;
}

export async function verifyToken(
  secret: string,
  token: string,
  purpose: TokenPayload["purpose"]
): Promise<TokenPayload | null> {
  const [bodyB64, sigB64] = token.split(".");
  if (!bodyB64 || !sigB64) return null;
  try {
    const body = b64urlDecode(bodyB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sigB64),
      body
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as TokenPayload;
    if (payload.purpose !== purpose || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "vs_session";
