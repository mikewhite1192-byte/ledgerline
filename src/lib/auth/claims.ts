import { isUuid } from "../uuid";

export type Session = { sub: string; email: string; tenantId: string };

// The signed-in user from a verified ID token. The tenant is the immutable custom:tenant_id
// attribute; a token without a UUID there, or without a subject, is no session at all.
export function tenantFromClaims(payload: Record<string, unknown>): Session | null {
  const sub = payload.sub;
  const tenantId = payload["custom:tenant_id"];
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (!isUuid(tenantId)) return null;
  const email = typeof payload.email === "string" ? payload.email : "";
  return { sub, email, tenantId };
}
