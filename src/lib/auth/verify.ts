import { readFileSync } from "node:fs";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  JwtExpiredError,
  JwtInvalidClaimError,
  JwtInvalidSignatureError,
  JwtParseError,
} from "aws-jwt-verify/error";
import type { Jwks } from "aws-jwt-verify/jwk";
import { localHooksAllowed, type LocalModeEnv } from "../../config/local-mode";
import { tenantFromClaims, type Session } from "./claims";

function createVerifier(userPoolId: string, clientId: string) {
  const created = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
  const jwks = localJwks();
  if (jwks) created.cacheJwks(jwks);
  return created;
}

let verifier: ReturnType<typeof createVerifier> | undefined;

// The demo-path test's own key set, in local mode only: AUTH_LOCAL_JWKS names a file the local
// sign-in host wrote, and the verifier trusts those keys instead of fetching the pool's. With an
// Aurora cluster configured, or NODE_ENV anything but development or test (a production build
// among them), the variable is ignored (one log line), so the verifier only ever trusts the real
// pool's keys there. An unreadable file trusts nothing.
export function localJwks(env: LocalModeEnv = process.env): Jwks | null {
  const path = env.AUTH_LOCAL_JWKS;
  if (path === undefined || path === "") return null;
  if (!localHooksAllowed(env)) {
    console.error("auth: AUTH_LOCAL_JWKS ignored outside local mode");
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const keys = (parsed as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || keys.length === 0) throw new Error("no keys");
    return parsed as Jwks;
  } catch {
    console.error("auth: local key set unreadable; trusting no local keys");
    return null;
  }
}

// Signature against the pool's JWKS (fetched once, then cached), issuer = this pool, audience =
// this app client, token_use = id, not expired. Returns the session or null; never throws to a
// page. The reason goes to the log as a category, never to the UI, and the token is never logged.
export async function verifyIdToken(token: string): Promise<Session | null> {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    console.error("auth: not configured");
    return null;
  }
  verifier ??= createVerifier(userPoolId, clientId);
  try {
    const payload = await verifier.verify(token);
    const session = tenantFromClaims(payload);
    if (!session) console.error("auth: token has no tenant");
    return session;
  } catch (err) {
    console.error(`auth: token rejected (${rejection(err)})`);
    return null;
  }
}

function rejection(err: unknown): string {
  if (err instanceof JwtExpiredError) return "expired";
  if (err instanceof JwtInvalidSignatureError) return "bad_signature";
  if (err instanceof JwtInvalidClaimError) return "wrong_claim";
  if (err instanceof JwtParseError) return "malformed";
  return "other";
}
