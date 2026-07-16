import { sha256Hex } from "./hash";

export type Identity = { orgId: string; agentId: string };

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `vs_${b64}`;
}

export async function authenticateApiKey(
  db: D1Database,
  apiKey: string
): Promise<Identity | null> {
  const keyHash = await sha256Hex(apiKey);
  const row = await db
    .prepare(
      "SELECT org_id, agent_id FROM agent_keys WHERE key_hash = ? AND revoked_at IS NULL"
    )
    .bind(keyHash)
    .first<{ org_id: string; agent_id: string }>();
  return row ? { orgId: row.org_id, agentId: row.agent_id } : null;
}

// Compare via hashes so inputs are equal-length, then timing-safe compare.
export async function timingSafeEqualStr(
  a: string,
  b: string
): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
