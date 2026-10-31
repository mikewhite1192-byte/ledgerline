import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { readZone } from "../autopilot/read";
import { withSessionTenant } from "../tenant/context";
import { isUuid } from "../uuid";
import { snoozeUntil } from "./snooze";
import { answerAsksFor, snoozeAsk } from "./store";

// The two writes a person makes on a question, each in one membership-checked tenant transaction.

// After a successful approve: the live ask about the proposal is answered. Never throws: the
// approval already went through, and an ask left open is voided by the desk's next pass.
export async function answerAfterApprove(session: Session, proposalId: string, now: Date = new Date()): Promise<void> {
  if (flags.agentAsks.enabled !== true || !isUuid(proposalId)) return;
  try {
    await withSessionTenant(session, (q) => answerAsksFor(q, proposalId, session.sub, now));
  } catch (err) {
    console.warn("asks: the answered mark could not be written:", err instanceof Error ? err.name : "unknown");
  }
}

// "Not now": the carrier's next 09:00, or 4 hours if sooner. Null when no live ask of a waiting
// proposal has that id in the caller's tenant.
export async function snoozeForSession(
  session: Session,
  askId: string,
  nowMs: number = Date.now(),
): Promise<{ snoozedUntil: string } | null> {
  if (!isUuid(askId)) return null;
  return withSessionTenant(session, async (q) => {
    const until = new Date(snoozeUntil(nowMs, await readZone(q))).toISOString();
    return (await snoozeAsk(q, askId, until, new Date(nowMs))) ? { snoozedUntil: until } : null;
  });
}
