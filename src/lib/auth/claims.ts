import { isUuid } from "../uuid";

// demoSessionId is set only by getSession() (./session.ts), for a judge with a live demo visit
// (the pc_demo cookie); a token alone never carries it. visitTicketId is set only for a visit
// that runs in its own copy of the demo carrier (flags.visitCopies): the session is then the
// copy's, as its admin "visit:<ticket id>", and visitTicketId names the visit's row in the demo
// carrier it was copied from.
export type Session = { sub: string; email: string; tenantId: string; demoSessionId?: string; visitTicketId?: string };

// The one login a visit's copy is run as (src/lib/visit-copy/build.ts writes its membership). It
// is not a Cognito id, so nobody signs in as it: only getSession() hands it out.
export const visitSub = (ticketId: string) => `visit:${ticketId.toLowerCase()}`;

export const isVisitSub = (sub: string) => sub.startsWith("visit:");

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
