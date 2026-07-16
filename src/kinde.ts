// Kinde OIDC (authorization-code flow, no SDK).
// https://docs.kinde.com/developer-tools/about/using-kinde-without-an-sdk/

import { b64urlDecode } from "./hash";

export const OAUTH_STATE_COOKIE = "vs_oauth_state";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export function authorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.KINDE_CLIENT_ID,
    redirect_uri: `${env.BASE_URL}/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
    state,
  });
  return `${env.KINDE_DOMAIN}/oauth2/auth?${params}`;
}

export function logoutUrl(env: Env): string {
  const params = new URLSearchParams({ redirect: `${env.BASE_URL}/login` });
  return `${env.KINDE_DOMAIN}/logout?${params}`;
}

/**
 * Exchanges the authorization code and returns the verified email.
 *
 * The id_token arrives directly from Kinde's token endpoint over TLS with
 * client-secret auth, so per OIDC 3.1.3.7 signature verification is optional
 * for this flow; we validate iss, aud, and exp.
 */
export async function exchangeCodeForEmail(
  env: Env,
  code: string
): Promise<{ email: string } | { error: string }> {
  const res = await fetch(`${env.KINDE_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KINDE_CLIENT_ID,
      client_secret: env.KINDE_CLIENT_SECRET,
      redirect_uri: `${env.BASE_URL}/auth/callback`,
      code,
    }),
  });
  if (!res.ok) {
    return { error: `token endpoint returned ${res.status}` };
  }
  const body = await res.json<{ id_token?: string }>();
  if (!body.id_token) return { error: "no id_token in response" };

  const parts = body.id_token.split(".");
  if (parts.length !== 3) return { error: "malformed id_token" };
  let claims: { iss?: string; aud?: string | string[]; exp?: number; email?: string };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return { error: "unparseable id_token payload" };
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== env.KINDE_DOMAIN) return { error: "issuer mismatch" };
  if (!audiences.includes(env.KINDE_CLIENT_ID)) return { error: "audience mismatch" };
  if (!claims.exp || claims.exp * 1000 < Date.now()) return { error: "token expired" };
  if (!claims.email) return { error: "no email claim" };

  return { email: claims.email.trim().toLowerCase() };
}
