import { flags } from "../../config/flags";
import { visitSub, type Session } from "../auth/claims";
import type { VisitTicket } from "../auth/session";
import { DbError, type Queryable, type TenantDb } from "../db";
import { startSweep } from "../sweep/run";
import { isUuid } from "../uuid";

// A visit's copy tells its own story (flags.visitCopies.startSweep): once the copy is marked ready,
// one real pay check starts inside it, so the visitor lands on Home and watches the coworker find
// the week's mistakes and draft the fixes (Home carries the run on, src/components/sweep/carry-on.tsx).
// Only the start happens here: no slice runs while the visitor waits. The run drafts fixes only;
// nothing here approves, pays or writes a money row, and every write is in the copy's own tenant.
// The day count alone reads the demo carrier: its own visit rows are where copy_ready_at lives.
//
// One run per copy: the run's id is the copy's own visit row id, so a second start for the same
// copy replays the first run (startSweep returns it, existing) and never opens another, whatever
// became of the first. startSweep also keeps one running run per week.
//
// The run's model calls go through the copy's sweep login, not the visit, so the visit's caps do
// not count them. flags.visitCopies.sweepDayCents does: the demo carrier's copies made ready since
// the UTC day began, this one included, each at the larger of the run caps, must fit within it.
// The ready mark commits before the count, so two copies made ready at once each count the other.
// A count that cannot be read, or a cap that is not a whole positive number, starts nothing.
//
// Never throws, and never holds up the ready answer: every outcome is one log line, with the
// error's name only.

export type CopySweepSkip = "off" | "not_configured" | "day_full" | "refused" | "failed";

export type CopySweepOutcome =
  | { started: true; runId: string; existing: boolean }
  | { started: false; reason: CopySweepSkip; category?: string };

export type CopySweepDeps = {
  // Tests pin the day and the run's clock; without one the count reads the database clock.
  clock?: () => Date;
  log?: (line: string) => void;
};

// The copy's session, as getSession() hands it to every request of the visit (src/lib/auth/session.ts).
export function copySessionOf(visit: VisitTicket): Session {
  const ticketId = visit.ticketId.toLowerCase();
  return {
    sub: visitSub(ticketId),
    email: visit.token.email,
    tenantId: visit.copy.tenantId,
    demoSessionId: visit.copy.sessionId,
    visitTicketId: ticketId,
    visitHome: { tenantId: visit.token.tenantId, sub: visit.token.sub },
  };
}

// The demo carrier's other visits whose copies were made ready since the UTC day `at` falls in
// began (null: the database clock), as the visit day caps bucket a day (src/lib/auth/demo-visit.ts).
export async function copiesReadyToday(q: Queryable, input: { visitId: string; at: string | null }): Promise<number> {
  if (!isUuid(input.visitId)) throw new DbError("unknown");
  const [row] = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM demo_sessions
      WHERE tenant_id = current_tenant_id() AND copy_tenant_id IS NOT NULL AND id <> CAST($1 AS uuid)
        AND copy_ready_at >= (date_trunc('day', COALESCE(CAST($2 AS timestamptz), now()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    [input.visitId, input.at],
  );
  if (!row || !Number.isSafeInteger(row.n) || row.n < 0) throw new DbError("unknown");
  return row.n;
}

const whole = (n: number) => Number.isSafeInteger(n) && n > 0;

export async function startCopySweep(
  db: TenantDb,
  visit: VisitTicket,
  deps: CopySweepDeps = {},
): Promise<CopySweepOutcome> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const skip = (reason: CopySweepSkip, category?: string): CopySweepOutcome => {
    log(`visit copy: sweep skipped ${reason}${category ? ` ${category}` : ""}`);
    return category ? { started: false, reason, category } : { started: false, reason };
  };
  try {
    // The switches are read here, not only by the caller; startSweep reads the sweep's again.
    if (flags.visitCopies.enabled !== true || flags.visitCopies.startSweep !== true || flags.sweepEnabled !== true) {
      return skip("off");
    }
    const dayCents = flags.visitCopies.sweepDayCents;
    const runCents = Math.max(flags.fanoutLimits.runCapCents, flags.sweepLimits.maxRunCents);
    if (!whole(dayCents) || !whole(runCents)) return skip("not_configured");
    const at = deps.clock ? deps.clock().toISOString() : null;
    const others = await db.withTenant(visit.token.tenantId, (q) =>
      copiesReadyToday(q, { visitId: visit.ticketId, at }),
    );
    if ((others + 1) * runCents > dayCents) return skip("day_full");
    const runId = visit.copy.sessionId.toLowerCase();
    const started = await startSweep(copySessionOf(visit), { runId, trigger: "button" }, { db, clock: deps.clock });
    if (!started.ok) return skip("refused", started.category);
    log(`visit copy: sweep ${started.runId} ${started.existing ? "kept" : "started"}`);
    return { started: true, runId: started.runId, existing: started.existing };
  } catch (err) {
    log(`visit copy: sweep skipped failed (${err instanceof Error ? err.name : "non-error"})`);
    return { started: false, reason: "failed" };
  }
}
