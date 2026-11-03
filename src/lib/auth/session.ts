import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { flags } from "../../config/flags";
import { getDb } from "../db";
import { isJudge } from "../roles";
import { visitSub, type Session } from "./claims";
import { DEMO_COOKIE, SESSION_COOKIE } from "./cookie";
import { readVisit, type VisitCopy } from "./demo-visit";
import { verifyIdToken } from "./verify";

// A visit whose own copy of the demo carrier is claimed (flags.visitCopies): the token's session
// in the demo carrier, the visit's id there, and the copy.
export type VisitTicket = { token: Session; ticketId: string; copy: VisitCopy };

type Read = {
  session: Session | null;
  visitEnded: boolean;
  // A visit whose copy is claimed but not built yet: no session until it is ready, and the
  // preparing page builds it.
  preparing: VisitTicket | null;
};

const NONE: Read = { session: null, visitEnded: false, preparing: null };

// The verified session for this request, or null. The token is checked on every request.
//
// A demo visit (src/app/sign-in/try-demo-action.ts) adds the pc_demo cookie. Only then, and only
// while flags.judgeAccess is on, one read in the token's tenant gives the subject's role and the
// visit: a judge with a live visit gets demoSessionId; a judge whose visit ended (or does not
// match) has no session and is sent to sign in again. For any other role the cookie is ignored. A
// failed read is a session without a visit, which a judge cannot spend from (src/lib/ai/spend.ts)
// or open an agent turn with (src/lib/agent/gateway/store/turns.ts): fail closed, and staff and
// admin are unchanged.
//
// While flags.visitCopies is on, a live judge visit that points at its own copy runs in the copy:
// the session is the copy's tenant, as the copy's admin login visitSub(ticket), with the copy's
// own visit row as demoSessionId, the ticket as visitTicketId and the token's carrier and login as
// visitHome (the copy's spend is counted on the ticket as well). A copy not built yet gives no
// session (requireSession sends it to /preparing); a purged copy is an ended visit. With copies
// on, a failed read is no session at all, so a visitor is never put back in the shared demo
// carrier. A visit with no copy is the shared one, as before; with copies off the copy columns
// are not used.
async function readSession(): Promise<Read> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return NONE;
  const session = await verifyIdToken(token);
  if (!session) return NONE;
  const visit = jar.get(DEMO_COOKIE)?.value;
  if (!visit || !flags.judgeAccess.enabled) return { session, visitEnded: false, preparing: null };
  const copies = flags.visitCopies.enabled === true;
  try {
    const read = await getDb().withTenant(session.tenantId, (q) => readVisit(q, session.sub, visit));
    if (read.role === null || !isJudge(read.role)) return { session, visitEnded: false, preparing: null };
    if (!read.live) return { session: null, visitEnded: true, preparing: null };
    if (copies && read.copy !== null) {
      const ticketId = visit.toLowerCase();
      if (read.copy.deleted) return { session: null, visitEnded: true, preparing: null };
      if (!read.copy.ready) return { session: null, visitEnded: false, preparing: { token: session, ticketId, copy: read.copy } };
      return {
        session: {
          sub: visitSub(ticketId),
          email: session.email,
          tenantId: read.copy.tenantId,
          demoSessionId: read.copy.sessionId,
          visitTicketId: ticketId,
          visitHome: { tenantId: session.tenantId, sub: session.sub },
        },
        visitEnded: false,
        preparing: null,
      };
    }
    return { session: { ...session, demoSessionId: visit }, visitEnded: false, preparing: null };
  } catch (err) {
    console.error(`session: the demo visit could not be read (${err instanceof Error ? err.name : "non-error"})`);
    if (copies) return NONE;
    return { session, visitEnded: false, preparing: null };
  }
}

export async function getSession(): Promise<Session | null> {
  return (await readSession()).session;
}

export async function requireSession(): Promise<Session> {
  const { session, visitEnded, preparing } = await readSession();
  if (preparing) redirect("/preparing");
  if (!session) redirect(visitEnded ? "/sign-in?demo=expired" : "/sign-in");
  return session;
}

// For the preparing page and its build action only: the visit whose copy is claimed and not built
// yet, or null for anything else (no visit, a ready or purged copy, copies off, a failed read).
export async function getPreparingVisit(): Promise<VisitTicket | null> {
  return (await readSession()).preparing;
}

// Where a request that is not preparing a copy belongs: Home once the copy is ready, the sign-in
// page otherwise.
export async function visitLanding(): Promise<"/" | "/sign-in" | "/sign-in?demo=expired"> {
  const { session, visitEnded } = await readSession();
  if (session) return "/";
  return visitEnded ? "/sign-in?demo=expired" : "/sign-in";
}
