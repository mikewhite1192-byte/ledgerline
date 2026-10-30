import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { flags } from "../../config/flags";
import { getDb } from "../db";
import { isJudge } from "../roles";
import type { Session } from "./claims";
import { DEMO_COOKIE, SESSION_COOKIE } from "./cookie";
import { readVisit } from "./demo-visit";
import { verifyIdToken } from "./verify";

type Read = { session: Session | null; visitEnded: boolean };

// The verified session for this request, or null. The token is checked on every request.
//
// A demo visit (src/app/sign-in/try-demo-action.ts) adds the pc_demo cookie. Only then, and only
// while flags.judgeAccess is on, one read in the token's tenant gives the subject's role and the
// visit: a judge with a live visit gets demoSessionId; a judge whose visit ended (or does not
// match) has no session and is sent to sign in again. For any other role the cookie is ignored. A
// failed read is a session without a visit, which a judge cannot spend from (src/lib/ai/spend.ts)
// or open an agent turn with (src/lib/agent/gateway/store/turns.ts): fail closed, and staff and
// admin are unchanged.
async function readSession(): Promise<Read> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return { session: null, visitEnded: false };
  const session = await verifyIdToken(token);
  if (!session) return { session: null, visitEnded: false };
  const visit = jar.get(DEMO_COOKIE)?.value;
  if (!visit || !flags.judgeAccess.enabled) return { session, visitEnded: false };
  try {
    const read = await getDb().withTenant(session.tenantId, (q) => readVisit(q, session.sub, visit));
    if (read.role === null || !isJudge(read.role)) return { session, visitEnded: false };
    if (!read.live) return { session: null, visitEnded: true };
    return { session: { ...session, demoSessionId: visit }, visitEnded: false };
  } catch (err) {
    console.error(`session: the demo visit could not be read (${err instanceof Error ? err.name : "non-error"})`);
    return { session, visitEnded: false };
  }
}

export async function getSession(): Promise<Session | null> {
  return (await readSession()).session;
}

export async function requireSession(): Promise<Session> {
  const { session, visitEnded } = await readSession();
  if (!session) redirect(visitEnded ? "/sign-in?demo=expired" : "/sign-in");
  return session;
}
