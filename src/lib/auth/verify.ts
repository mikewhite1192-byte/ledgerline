import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  JwtExpiredError,
  JwtInvalidClaimError,
  JwtInvalidSignatureError,
  JwtParseError,
} from "aws-jwt-verify/error";
import { tenantFromClaims, type Session } from "./claims";

function createVerifier(userPoolId: string, clientId: string) {
  return CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
}

let verifier: ReturnType<typeof createVerifier> | undefined;

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
