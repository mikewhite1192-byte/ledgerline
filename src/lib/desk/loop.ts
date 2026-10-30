import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import { readDaySpend, readSpendSince } from "../ai/watch";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isLocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import {
  findPeriods,
  findSubjects,
  maxInstant,
  MOVE_WATERMARK_SQL,
  SUBJECT_FINDERS,
  type DiscoverInput,
  type Watermarks,
} from "./discover";
import { deskHandlers, type Handlers } from "./handlers";
import { localMidnightOf, localNowOf, type DeskSource } from "./keys";
import { appendLine, categoryWord, readSeenSince, readState, type Line, type LineDetail, type OpenEvent, type WakeBy } from "./log";

// One wake of one carrier's desk loop (design 3): claim the loop's lease, write a wake line, find
// new work, then pick, claim, run and record one piece of work at a time until the deadline, a cap
// or no work is left; write a sleep line with the reason; give the lease back. Nothing is kept in
// memory between wakes: the log and the handlers' own rows are the whole state.

// Wakes a still-running piece of work is carried through before it is given up (a sweep or a
// card check finishes, or is given up by its own lease, long before this).
export const MAX_CARRIES = 30;

// Open events one wake reads back from the log.
export const STATE_LIMIT = 200;

export type SleepReason = "no_work" | "deadline" | "events_per_wake" | "wake_cents" | "day_cents" | "events_per_day";

export type WakeCounts = {
  seen: number;
  claimed: number;
  done: number;
  carried: number;
  skipped: number;
  failed: number;
  // Open events left for another wake now (not those whose try this wake did not come back).
  left: number;
};

export type WakeResult =
  | { ok: true; wakeId: string; status: "done" | "more" | "busy"; reason: SleepReason | null; counts: WakeCounts }
  | { ok: false; category: "disabled" | "bad_request" | "not_configured" | "unavailable" };

// The lease's row as stored: the carrier's zone, and the watermarks as written (read into their
// one form by the loop, once it knows the carrier's start).
export type Claimed = { watermarks: Record<keyof Watermarks, unknown>; zone: string };

export type Caps = { seenToday: number; wakeNanocents: number; dayNanocents: number };

// What the loop reads and writes, so it can run on fakes in tests. dbDeskStore is the real one.
export type DeskStore = {
  claim(input: { token: string; nowIso: string; leaseUntilIso: string }): Promise<Claimed | null>;
  // Sets running_since once, only while this wake holds the lease (armed, on or after the start).
  startClock(input: { token: string; nowIso: string }): Promise<void>;
  release(input: { token: string; nowIso: string }): Promise<void>;
  append(line: Line): Promise<boolean>;
  discover(input: DiscoverInput & { token: string }): Promise<number>;
  state(sinceStart: string): Promise<OpenEvent[]>;
  seenSince(sinceIso: string): Promise<number>;
  spend(input: { wakeStartIso: string; nowIso: string }): Promise<{ wakeNanocents: number; dayNanocents: number }>;
};

export type LoopDeps = {
  db?: TenantDb;
  clock?: () => Date;
  newId?: () => string;
  handlers?: Handlers;
  store?: DeskStore;
  log?: (line: string) => void;
};

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A stored watermark in the one form discovery writes; anything else reads from the start again
// (the log keeps every row it already found out).
function watermarkOf(value: unknown, startInstant: string): string {
  return typeof value === "string" && ISO_MS.test(value) ? maxInstant(value, startInstant) : startInstant;
}

const CLAIM_ROW_SQL = `INSERT INTO desk_loops (tenant_id, updated_at)
VALUES (current_tenant_id(), CAST($1 AS timestamptz)) ON CONFLICT (tenant_id) DO NOTHING`;

// The lease: taken only when free or lapsed, by the clock's instant (not the database's), so the
// wake and its lease read the same time.
const CLAIM_LEASE_SQL = `UPDATE desk_loops
    SET lease_token = CAST($2 AS uuid), lease_until = CAST($3 AS timestamptz), updated_at = CAST($1 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND (lease_until IS NULL OR lease_until < CAST($1 AS timestamptz))
  RETURNING watermarks->>'card_transactions' AS card_transactions, watermarks->>'customer_payments' AS customer_payments,
            (SELECT t.timezone FROM tenants t WHERE t.id = current_tenant_id()) AS zone`;

// The panel's "running since": set once, by the lease holder only.
const START_CLOCK_SQL = `UPDATE desk_loops SET running_since = CAST($2 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($1 AS uuid) AND running_since IS NULL`;

const RELEASE_SQL = `UPDATE desk_loops
    SET lease_token = NULL, lease_until = NULL, last_wake_at = CAST($2 AS timestamptz), updated_at = CAST($2 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($1 AS uuid)`;

export function dbDeskStore(db: TenantDb, session: Session): DeskStore {
  const inTenant = <T>(fn: (q: Queryable) => Promise<T>) =>
    db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return fn(q);
    });
  return {
    claim: (input) =>
      inTenant(async (q) => {
        await q.execute(CLAIM_ROW_SQL, [input.nowIso]);
        const rows = await q.query<{ card_transactions: unknown; customer_payments: unknown; zone: unknown }>(
          CLAIM_LEASE_SQL,
          [input.nowIso, input.token, input.leaseUntilIso],
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        if (typeof r.zone !== "string" || r.zone.length === 0) throw new DbError("unknown");
        return {
          zone: r.zone,
          watermarks: { card_transactions: r.card_transactions, customer_payments: r.customer_payments },
        };
      }),
    startClock: async (input) => {
      await inTenant((q) => q.execute(START_CLOCK_SQL, [input.token, input.nowIso]));
    },
    release: async (input) => {
      await db.withTenant(session.tenantId, (q) => q.execute(RELEASE_SQL, [input.token, input.nowIso]));
    },
    append: (line) => db.withTenant(session.tenantId, (q) => appendLine(q, line)),
    discover: async (input) => {
      let budget = input.budget;
      let seen = 0;
      const periods = await inTenant((q) => findPeriods(q, { ...input, budget }));
      seen += periods.seen;
      budget -= periods.seen;
      for (const finder of SUBJECT_FINDERS) {
        if (budget <= 0) break;
        const found = await inTenant(async (q) => {
          const r = await findSubjects(q, { ...input, budget }, finder);
          if (r.watermark) {
            // Only the lease holder moves a watermark; a wake whose lease was taken over writes nothing.
            const moved = await q.execute(MOVE_WATERMARK_SQL, [r.watermark.name, r.watermark.value, input.nowIso, input.token]);
            if (moved !== 1) throw new DbError("unknown");
          }
          return r.seen;
        });
        seen += found;
        budget -= found;
      }
      return seen;
    },
    state: (sinceStart) => inTenant((q) => readState(q, { sinceStart, limit: STATE_LIMIT })),
    seenSince: (sinceIso) => inTenant((q) => readSeenSince(q, sinceIso)),
    spend: (input) =>
      inTenant(async (q) => ({
        wakeNanocents: (await readSpendSince(q, input.wakeStartIso)).spentNanocents,
        dayNanocents: (await readDaySpend(q, input.nowIso)).spentNanocents,
      })),
  };
}

// The line each outcome writes, which is also the count it adds to.
const OUTCOME_LINES = { done: "done", running: "carried", skipped: "skipped", failed: "failed" } as const;

const zero = (): WakeCounts => ({ seen: 0, claimed: 0, done: 0, carried: 0, skipped: 0, failed: 0, left: 0 });

function errorName(err: unknown): string {
  if (err instanceof DbError) return err.category;
  return err instanceof Error ? categoryWord(err.name.toLowerCase()) : "unknown";
}

// The limits as they must be: whole, positive. Anything else is not configured.
function readLimits() {
  const l = flags.deskLoop.limits;
  const values = [l.sliceMs, l.leaseMs, l.eventsPerWake, l.eventsPerDay, l.maxAttempts, l.wakeCents, l.dayCents];
  if (!values.every((v) => Number.isSafeInteger(v) && v > 0)) return null;
  if (!isLocalDate(flags.deskLoop.startDate)) return null;
  return l;
}

export async function wakeDesk(
  session: Session,
  input: { wakeId: string; by: WakeBy; deadlineMs: number },
  deps: LoopDeps = {},
): Promise<WakeResult> {
  // The switch is read here, whoever calls.
  if (flags.deskLoop.enabled !== true) return { ok: false, category: "disabled" };
  if (!isUuid(input.wakeId) || (input.by !== "schedule" && input.by !== "button") || !Number.isFinite(input.deadlineMs)) {
    return { ok: false, category: "bad_request" };
  }
  const limits = readLimits();
  if (!limits) return { ok: false, category: "not_configured" };
  const armed = flags.deskLoop.armed === true;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const store = deps.store ?? dbDeskStore(deps.db ?? getDb(), session);
  const handlers = deps.handlers ?? deskHandlers({ db: deps.db, newId });
  const log = deps.log ?? ((line: string) => console.log(line));
  const wakeId = input.wakeId.toLowerCase();
  const startedAt = clock();
  const wakeStartIso = startedAt.toISOString();
  const deadlineMs = Math.min(input.deadlineMs, startedAt.getTime() + limits.sliceMs);
  const token = newId();
  const counts = zero();

  let claimed: Claimed | null;
  try {
    claimed = await store.claim({
      token,
      nowIso: wakeStartIso,
      leaseUntilIso: new Date(startedAt.getTime() + limits.leaseMs).toISOString(),
    });
  } catch (err) {
    log(`desk wake tenant=${session.tenantId} wake=${wakeId} claim_failed=${errorName(err)}`);
    return { ok: false, category: "unavailable" };
  }
  if (!claimed) return { ok: true, wakeId, status: "busy", reason: null, counts };

  const line = (kind: Line["kind"], event: { eventKey: string; source: DeskSource } | null, detail: LineDetail = {}) =>
    store.append({
      id: newId(),
      wakeId,
      at: clock().toISOString(),
      kind,
      eventKey: event ? event.eventKey : null,
      source: event ? event.source : null,
      subjectId: null,
      by: input.by,
      detail,
    });

  try {
    await line("wake", null, armed ? {} : { category: "unarmed" });

    // The loop's start: the carrier's own midnight on the start date, not UTC's.
    const startInstant = localMidnightOf(flags.deskLoop.startDate, claimed.zone);
    // The panel's "running since" starts with the first armed wake on or after the start.
    if (armed && wakeStartIso >= startInstant) await store.startClock({ token, nowIso: wakeStartIso });
    const watermarks: Watermarks = {
      card_transactions: watermarkOf(claimed.watermarks.card_transactions, startInstant),
      customer_payments: watermarkOf(claimed.watermarks.customer_payments, startInstant),
    };

    // Discovery, inside the day's share.
    const seenToday = await store.seenSince(new Date(startedAt.getTime() - 86_400_000).toISOString());
    const dayLeft = Math.max(0, limits.eventsPerDay - seenToday);
    const budget = Math.min(limits.eventsPerWake, dayLeft);
    if (budget > 0) {
      counts.seen = await store.discover({
        wakeId,
        by: input.by,
        startInstant,
        nowIso: clock().toISOString(),
        nowLocal: localNowOf(clock().toISOString(), claimed.zone),
        startDate: flags.deskLoop.startDate,
        watermarks,
        budget,
        newId,
        token,
      });
    }
    // Discovery stopped at the day's share, or at this wake's: there may be more to find.
    const dayCapped = dayLeft <= limits.eventsPerWake && counts.seen >= dayLeft;
    const wakeCapped = !dayCapped && counts.seen >= limits.eventsPerWake;

    const open = await store.state(startInstant);
    let reason: SleepReason | null = null;
    let picks = 0;
    let started = 0;
    // Pieces of work whose try this wake did not come back.
    let unanswered = 0;
    for (const event of open) {
      // Bookkeeping first: a piece of work out of tries, or carried too long, is given up.
      if (event.state === "claimed" && event.attempts >= limits.maxAttempts) {
        await line("failed", event, { category: "abandoned" });
        counts.failed += 1;
        continue;
      }
      if (event.state === "carried" && event.carries >= MAX_CARRIES) {
        await line("failed", event, { runId: event.runId ?? undefined, category: "abandoned" });
        counts.failed += 1;
        continue;
      }
      if (picks >= limits.eventsPerWake) {
        reason = "events_per_wake";
        break;
      }
      const now = clock().getTime();
      if (now >= deadlineMs) {
        reason = "deadline";
        break;
      }
      if (!armed) {
        picks += 1;
        await line("skipped", event, { category: "unarmed" });
        counts.skipped += 1;
        continue;
      }
      const handler = handlers[event.source];
      if (!handler.switchOn()) {
        picks += 1;
        await line("skipped", event, { category: "switched_off" });
        counts.skipped += 1;
        continue;
      }
      // Only the wake's first piece of work may need more than what is left of the slice.
      if (started > 0 && deadlineMs - now < handler.needsMs) {
        reason = "deadline";
        break;
      }
      // The caps stop the wake before the next piece of work, read fresh each time.
      const spent = await store.spend({ wakeStartIso, nowIso: clock().toISOString() });
      if (spent.wakeNanocents >= limits.wakeCents * NANOCENTS_PER_CENT) {
        reason = "wake_cents";
        break;
      }
      if (spent.dayNanocents >= limits.dayCents * NANOCENTS_PER_CENT) {
        reason = "day_cents";
        break;
      }
      picks += 1;
      // A carried piece of work goes on without a new try; any other is one try, claimed first.
      if (event.state !== "carried") {
        await line("claimed", event);
        counts.claimed += 1;
      }
      started += 1;
      let outcome;
      try {
        outcome = await handler.run(session, event, { deadlineMs, clock });
      } catch (err) {
        // Not known: the claimed line stays the latest, and a later wake tries again (or gives up at
        // maxAttempts). It alone does not ask for another wake now. The name goes to the log, never
        // into a line.
        log(`desk handler tenant=${session.tenantId} wake=${wakeId} source=${event.source} error=${errorName(err)}`);
        unanswered += 1;
        continue;
      }
      const kind = OUTCOME_LINES[outcome.outcome];
      await line(kind, event, outcome.detail);
      counts[kind] += 1;
    }

    if (reason === null) reason = dayCapped ? "events_per_day" : wakeCapped ? "events_per_wake" : "no_work";
    // What is still open for another wake now: the events not reached and those carried on. One
    // whose try did not come back is not counted, so a try that keeps throwing does not spend its
    // attempts in one kick's run of wakes by itself.
    counts.left = Math.max(0, open.length - (counts.done + counts.skipped + counts.failed + unanswered));
    await line("sleep", null, { found: counts.done, category: reason });
    // Spent caps stop until the next scheduled wake. Otherwise, work left (or more to find) asks
    // for another wake now.
    const more =
      reason !== "wake_cents" &&
      reason !== "day_cents" &&
      (counts.left > 0 || reason === "events_per_wake" || reason === "deadline");
    return { ok: true, wakeId, status: more ? "more" : "done", reason, counts };
  } catch (err) {
    log(`desk wake tenant=${session.tenantId} wake=${wakeId} failed=${errorName(err)}`);
    try {
      await line("sleep", null, { category: "read_failed" });
    } catch {
      // The lease lapses on its own; the next wake reads the log as it stands.
    }
    return { ok: false, category: "unavailable" };
  } finally {
    try {
      await store.release({ token, nowIso: clock().toISOString() });
    } catch (err) {
      log(`desk wake tenant=${session.tenantId} wake=${wakeId} release_failed=${errorName(err)}`);
    }
  }
}
