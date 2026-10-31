import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { serviceSession } from "../sweep/service-session";
import { deskHandlers, type Handler, type Handlers } from "./handlers";
import { DESK_SOURCES, eventKey, type DeskSource } from "./keys";
import { appendLine, AWAITING_RECHECK, readState, type Line, type OpenEvent } from "./log";
import { MOVE_WATERMARK_SQL } from "./discover";
import { wakeDesk } from "./loop";
import { readApprovalBreaks, readDeskLog, readDeskPanel } from "./view";

// The desk loop against the real database, as the app's role, with stand-in handlers and a fixed
// clock: one wake at a time per carrier (a live lease answers busy, a lapsed one is taken); each
// piece of work is found once and done once, even after a wake died mid-try; nothing from before
// the start date is found; the log can only grow (no update, delete or truncate, for the app or the
// admin), yet goes with its carrier; and another carrier sees none of it. The clock sits in January
// 2026, so a row the fixtures stamp with the real time is always after it and never found. Only
// this file's carriers are made, and they are removed after.

const START_DATE = "2026-01-05";
// Tuesday Jan 6, 2026, 09:00 in Chicago: the sweep and collections are due, the cash check is not.
const T0 = Date.parse("2026-01-06T15:00:00.000Z");
const saved = structuredClone(flags.deskLoop);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

type Carrier = { fixture: Fixture; service: Session };

async function carrier(slug: string): Promise<Carrier> {
  const fixture = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(fixture);
  await admin.withTenant(fixture.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@desk-test.invalid', 'staff')`,
    ),
  );
  const service = await serviceSession(app, fixture.tenantId);
  if (!service) throw new Error("no service login");
  return { fixture, service };
}

// A customer payment written at a fixed instant (the loop finds rows by when they were written).
async function payment(c: Carrier, at: string): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(c.fixture.tenantId, (q) =>
    q.execute(
      `INSERT INTO customer_payments (id, tenant_id, customer_id, received_on, amount_cents, method, payment_ref, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST('2026-01-06' AS date), 12500, 'ach', $3, 'ui',
         CAST($4 AS timestamptz))`,
      [id, c.fixture.customerId, `ACH-${id.slice(0, 8)}`, at],
    ),
  );
  return id;
}

type Call = { source: DeskSource; key: string; state: OpenEvent["state"]; attempts: number };

function recording(calls: Call[], run?: Handler["run"]): Handlers {
  const out = {} as Handlers;
  for (const source of DESK_SOURCES) {
    out[source] = {
      switchOn: () => true,
      needsMs: 1_000,
      run: async (session, event, ctx) => {
        calls.push({ source, key: event.eventKey, state: event.state, attempts: event.attempts });
        return run ? run(session, event, ctx) : { outcome: "done", detail: { found: 1 } };
      },
    };
  }
  return out;
}

let now: number;
const clock = () => new Date(now);
const logs: string[] = [];

function wake(c: Carrier, handlers: Handlers, db: TenantDb = app) {
  return wakeDesk(
    c.service,
    { wakeId: randomUUID(), by: "schedule", deadlineMs: now + 25_000 },
    { db, clock, handlers, newId: randomUUID, log: (l) => logs.push(l) },
  );
}

const linesOf = (c: Carrier) =>
  admin.withTenant(c.fixture.tenantId, (q) =>
    q.query<{ kind: string; event_key: string | null; subject_table: string | null; subject_id: string | null; detail: Record<string, unknown> }>(
      `SELECT kind, event_key, subject_table, CAST(subject_id AS text) AS subject_id, detail
         FROM desk_log WHERE tenant_id = current_tenant_id()
        ORDER BY at, CASE kind WHEN 'wake' THEN 0 WHEN 'seen' THEN 1 WHEN 'claimed' THEN 2 WHEN 'carried' THEN 3
                               WHEN 'sleep' THEN 5 ELSE 4 END, event_key`,
    ),
  );

const loopRow = (c: Carrier) =>
  admin.withTenant(c.fixture.tenantId, async (q) => {
    const [row] = await q.query<{ running_since: string | null; lease_token: string | null; watermarks: Record<string, string> }>(
      `SELECT to_char(running_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS running_since,
              CAST(lease_token AS text) AS lease_token, watermarks
         FROM desk_loops WHERE tenant_id = current_tenant_id()`,
    );
    return row;
  });

function line(over: Partial<Line> & Pick<Line, "kind">): Line {
  return {
    id: randomUUID(),
    wakeId: randomUUID(),
    at: new Date(T0 - 3_600_000).toISOString(),
    eventKey: null,
    source: null,
    subjectId: null,
    by: "schedule",
    detail: {},
    ...over,
  };
}

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
});

afterAll(async () => {
  for (const f of made) await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  flags.deskLoop.enabled = true;
  flags.deskLoop.armed = true;
  flags.deskLoop.startDate = START_DATE;
  Object.assign(flags.deskLoop.limits, saved.limits);
  now = T0;
  logs.length = 0;
});

afterEach(() => {
  flags.deskLoop.enabled = saved.enabled;
  flags.deskLoop.armed = saved.armed;
  flags.deskLoop.startDate = saved.startDate;
  Object.assign(flags.deskLoop.limits, saved.limits);
});

describe("one wake", () => {
  it("finds the due periods and new payments once, runs each once, and moves the watermark", async () => {
    const c = await carrier("desk-wake");
    await payment(c, "2026-01-04T12:00:00.000Z");
    const p1 = await payment(c, "2026-01-06T12:00:00.000Z");
    const p2 = await payment(c, "2026-01-06T14:00:00.000Z");
    const later = await payment(c, "2026-01-06T16:00:00.000Z");
    const calls: Call[] = [];

    const first = await wake(c, recording(calls));
    expect(first).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(calls.map((x) => x.key).sort()).toEqual(
      ["collections:2026-01-06", "sweep:2026-01-06", eventKey("customer_payment", p1), eventKey("customer_payment", p2)].sort(),
    );
    expect(first.ok && first.counts).toEqual({ seen: 4, claimed: 4, done: 4, carried: 0, skipped: 0, failed: 0, left: 0 });
    const lines = await linesOf(c);
    expect(lines.filter((l) => l.kind === "done")).toHaveLength(4);
    expect(lines.find((l) => l.event_key === eventKey("customer_payment", p1) && l.kind === "seen")).toMatchObject({
      subject_table: "customer_payments",
      subject_id: p1,
    });
    expect(lines.find((l) => l.event_key === "sweep:2026-01-06")).toMatchObject({ subject_table: null, subject_id: null });
    const row = await loopRow(c);
    expect(row).toMatchObject({ running_since: "2026-01-06T15:00:00.000Z", lease_token: null });
    expect(row.watermarks.customer_payments).toBe("2026-01-06T14:00:00.000Z");

    // Fifteen minutes on: nothing new, nothing run again. Then the later payment's time comes.
    now += 15 * 60_000;
    const second = await wake(c, recording(calls));
    expect(second).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(calls).toHaveLength(4);
    now = Date.parse("2026-01-06T16:30:00.000Z");
    await wake(c, recording(calls));
    expect(calls.map((x) => x.key).slice(4)).toEqual([eventKey("customer_payment", later)]);
    expect((await loopRow(c)).watermarks.customer_payments).toBe("2026-01-06T16:00:00.000Z");
    expect((await loopRow(c)).running_since).toBe("2026-01-06T15:00:00.000Z");
  });

  it("finds nothing before the start date, and starts no clock while unarmed", async () => {
    const c = await carrier("desk-before");
    await payment(c, "2026-01-04T12:00:00.000Z");
    const calls: Call[] = [];
    now = Date.parse("2026-01-04T15:00:00.000Z");
    const out = await wake(c, recording(calls));
    expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(out.ok && out.counts.seen).toBe(0);
    expect((await linesOf(c)).map((l) => l.kind)).toEqual(["wake", "sleep"]);
    expect((await loopRow(c)).running_since).toBeNull();

    flags.deskLoop.armed = false;
    now = T0;
    const unarmed = await wake(c, recording(calls));
    expect(calls).toEqual([]);
    expect(unarmed.ok && unarmed.counts).toMatchObject({ seen: 2, skipped: 2, claimed: 0 });
    expect((await loopRow(c)).running_since).toBeNull();
    const skipped = (await linesOf(c)).filter((l) => l.kind === "skipped");
    expect(skipped.map((l) => l.detail)).toEqual([{ category: "unarmed" }, { category: "unarmed" }]);
  });

  it("starts at the carrier's own midnight on the start date, not UTC's", async () => {
    // Chicago's midnight on Jan 5 is 06:00 UTC.
    const c = await carrier("desk-midnight");
    await payment(c, "2026-01-05T03:00:00.000Z");
    const after = await payment(c, "2026-01-05T07:00:00.000Z");
    const calls: Call[] = [];
    now = Date.parse("2026-01-05T05:00:00.000Z");
    const early = await wake(c, recording(calls));
    expect(early.ok && early.counts.seen).toBe(0);
    expect(calls).toEqual([]);
    expect((await loopRow(c)).running_since).toBeNull();

    now = T0;
    await wake(c, recording(calls));
    expect(calls.map((x) => x.key).filter((k) => k.startsWith("customer_payment:"))).toEqual([
      eventKey("customer_payment", after),
    ]);
    expect((await loopRow(c)).running_since).toBe("2026-01-06T15:00:00.000Z");
  });
});

describe("the lease", () => {
  it("answers busy under another wake's live lease, and takes a lapsed one", async () => {
    const c = await carrier("desk-lease");
    const calls: Call[] = [];
    await wake(c, recording(calls));
    const held = randomUUID();
    await admin.withTenant(c.fixture.tenantId, (q) =>
      q.execute(
        "UPDATE desk_loops SET lease_token = CAST($1 AS uuid), lease_until = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id()",
        [held, new Date(T0 + 30_000).toISOString()],
      ),
    );
    const before = (await linesOf(c)).length;
    expect(await wake(c, recording(calls))).toMatchObject({ ok: true, status: "busy" });
    expect((await linesOf(c)).length).toBe(before);
    expect((await loopRow(c)).lease_token).toBe(held);

    // Only the lease holder moves a watermark.
    const moved = await app.withTenant(c.fixture.tenantId, (q) =>
      q.execute(MOVE_WATERMARK_SQL, ["customer_payments", "2026-01-06T15:00:00.000Z", new Date(T0).toISOString(), randomUUID()]),
    );
    expect(moved).toBe(0);

    now = T0 + 31_000;
    expect(await wake(c, recording(calls))).toMatchObject({ ok: true, status: "done" });
    expect((await loopRow(c)).lease_token).toBeNull();
  });
});

describe("done once", () => {
  it("resumes a piece of work whose wake died mid-try, and does it once", async () => {
    const c = await carrier("desk-resume");
    const key = "sweep:2026-01-06";
    await app.withTenant(c.fixture.tenantId, async (q) => {
      await appendLine(q, line({ kind: "seen", eventKey: key, source: "sweep" }));
      await appendLine(q, line({ kind: "claimed", eventKey: key, source: "sweep" }));
    });
    const calls: Call[] = [];
    await wake(c, recording(calls));
    expect(calls.filter((x) => x.key === key)).toEqual([{ source: "sweep", key, state: "claimed", attempts: 1 }]);
    now += 15 * 60_000;
    await wake(c, recording(calls));
    expect(calls.filter((x) => x.key === key)).toHaveLength(1);
    const lines = (await linesOf(c)).filter((l) => l.event_key === key);
    expect(lines.map((l) => l.kind)).toEqual(["seen", "claimed", "claimed", "done"]);
  });

  it("keeps a piece of work closed once it is done, whatever a late wake writes after it", async () => {
    const c = await carrier("desk-closed");
    const key = "sweep:2026-01-06";
    const at = (ms: number) => new Date(T0 - ms).toISOString();
    await app.withTenant(c.fixture.tenantId, async (q) => {
      await appendLine(q, line({ kind: "seen", eventKey: key, source: "sweep", at: at(3_600_000) }));
      await appendLine(q, line({ kind: "claimed", eventKey: key, source: "sweep", at: at(3_600_000) }));
      await appendLine(q, line({ kind: "done", eventKey: key, source: "sweep", at: at(3_000_000) }));
      // A wake frozen at the route's limit thaws and records its old try as still running.
      await appendLine(q, line({ kind: "carried", eventKey: key, source: "sweep", at: at(60_000), detail: { runId: randomUUID() } }));
    });
    const open = await app.withTenant(c.fixture.tenantId, (q) =>
      readState(q, { sinceStart: "2026-01-05T06:00:00.000Z", limit: 50 }),
    );
    expect(open.map((e) => e.eventKey)).not.toContain(key);
    const calls: Call[] = [];
    await wake(c, recording(calls));
    expect(calls.filter((x) => x.key === key)).toEqual([]);
    const lines = (await linesOf(c)).filter((l) => l.event_key === key);
    expect(lines.map((l) => l.kind)).toEqual(["seen", "claimed", "done", "carried"]);
  });

  it("puts a finalize waiting for the dispatch recheck after every other open piece of work", async () => {
    const c = await carrier("desk-waits-last");
    const at = (ms: number) => new Date(T0 - 60_000 + ms).toISOString();
    const eventId = randomUUID();
    const waiting = eventKey("tms_event", eventId);
    const carried = "sweep:2026-01-06";
    const fresh = "sweep:2026-01-07";
    await app.withTenant(c.fixture.tenantId, async (q) => {
      // The oldest: a finalize carried while it waits; then a carried run; then new work.
      await appendLine(q, line({ kind: "seen", eventKey: waiting, source: "tms_event", subjectId: eventId, at: at(0) }));
      await appendLine(q, line({ kind: "claimed", eventKey: waiting, source: "tms_event", subjectId: eventId, at: at(1_000) }));
      await appendLine(
        q,
        line({ kind: "carried", eventKey: waiting, source: "tms_event", subjectId: eventId, at: at(2_000), detail: { category: AWAITING_RECHECK } }),
      );
      await appendLine(q, line({ kind: "seen", eventKey: carried, source: "sweep", at: at(3_000) }));
      await appendLine(q, line({ kind: "claimed", eventKey: carried, source: "sweep", at: at(4_000) }));
      await appendLine(q, line({ kind: "carried", eventKey: carried, source: "sweep", at: at(5_000), detail: { runId: randomUUID() } }));
      await appendLine(q, line({ kind: "seen", eventKey: fresh, source: "sweep", at: at(6_000) }));
    });
    const open = await app.withTenant(c.fixture.tenantId, (q) =>
      readState(q, { sinceStart: "2026-01-05T06:00:00.000Z", limit: 50 }),
    );
    expect(open.map((e) => e.eventKey)).toEqual([carried, fresh, waiting]);
  });

  it("gives up a carried piece of work whose tries keep throwing at maxAttempts, keeping its run", async () => {
    const c = await carrier("desk-threw");
    const key = "sweep:2026-01-06";
    const runId = randomUUID();
    await app.withTenant(c.fixture.tenantId, async (q) => {
      await appendLine(q, line({ kind: "seen", eventKey: key, source: "sweep" }));
      await appendLine(q, line({ kind: "claimed", eventKey: key, source: "sweep" }));
      await appendLine(q, line({ kind: "carried", eventKey: key, source: "sweep", detail: { runId, found: 2 } }));
    });
    const calls: Call[] = [];
    const throwing = recording(calls, async () => {
      throw new TypeError("run failed for driver Ana");
    });
    const readKey = async () =>
      (await app.withTenant(c.fixture.tenantId, (q) => readState(q, { sinceStart: "2026-01-05T06:00:00.000Z", limit: 50 }))).find(
        (e) => e.eventKey === key,
      );
    for (let i = 0; i < flags.deskLoop.limits.maxAttempts; i++) {
      await wake(c, throwing);
      expect(await readKey()).toMatchObject({ state: "carried", runId, found: 2, attempts: 1, carries: 2 + i, threw: 1 + i });
      now += 15 * 60_000;
    }
    await wake(c, throwing);
    expect(calls.filter((x) => x.key === key)).toHaveLength(flags.deskLoop.limits.maxAttempts);
    expect(await readKey()).toBeUndefined();
    const lines = (await linesOf(c)).filter((l) => l.event_key === key);
    expect(lines.map((l) => l.kind)).toEqual(["seen", "claimed", "carried", "carried", "carried", "carried", "failed"]);
    expect(lines.slice(3, 6).map((l) => l.detail)).toEqual(
      Array.from({ length: 3 }, () => ({ runId: runId.toLowerCase(), found: 2, category: "threw" })),
    );
    expect(lines[6].detail).toEqual({ runId: runId.toLowerCase(), category: "abandoned" });
    expect(JSON.stringify(lines)).not.toContain("Ana");
  });

  it("refuses a second done line for the same piece of work", async () => {
    const c = await carrier("desk-dedupe");
    const key = eventKey("customer_payment", c.fixture.paymentId);
    const done = line({ kind: "done", eventKey: key, source: "customer_payment" });
    await app.withTenant(c.fixture.tenantId, async (q) => {
      expect(await appendLine(q, done)).toBe(true);
      expect(await appendLine(q, { ...done, id: randomUUID() })).toBe(false);
    });
    const raw = app.withTenant(c.fixture.tenantId, (q) =>
      q.execute(
        `INSERT INTO desk_log (id, tenant_id, wake_id, kind, event_key, source, by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'done', $3, 'customer_payment', 'schedule')`,
        [randomUUID(), randomUUID(), key],
      ),
    );
    expect(await sqlStateOf(raw)).toBe("23505");
    expect((await linesOf(c)).filter((l) => l.kind === "done")).toHaveLength(1);
  });
});

describe("the cash check", () => {
  it("answers with a check stored since the week's event was first seen, and stores no second one", async () => {
    const c = await carrier("desk-cash");
    const t = c.fixture.tenantId;
    const periodId = randomUUID();
    await admin.withTenant(t, (q) =>
      q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), DATE '2025-12-29', DATE '2026-01-04', 'open')`,
        [periodId],
      ),
    );
    const check = (id: string, at: string, options: string) =>
      admin.withTenant(t, (q) =>
        q.execute(
          `INSERT INTO cash_checks (id, tenant_id, period_id, as_of, pay_day, figures, options, gap_cents, pay_run_source,
             created_by, created_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), DATE '2026-01-09', DATE '2026-01-09',
             CAST('{"gapCents":-680000}' AS jsonb), CAST($3 AS jsonb), -680000, 'preview', 'desk-test', CAST($4 AS timestamptz))`,
          [id, periodId, options, at],
        ),
      );
    const countChecks = async () =>
      (await admin.withTenant(t, (q) =>
        q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM cash_checks WHERE tenant_id = current_tenant_id()"),
      ))[0].n;
    const firstAt = "2026-01-09T12:00:00.000Z";
    const event: OpenEvent = {
      eventKey: "cash_check:2026-W02",
      source: "cash_check",
      subjectId: null,
      state: "claimed",
      attempts: 2,
      carries: 0,
      threw: 0,
      runId: null,
      found: null,
      firstAt,
    };
    const handler = deskHandlers({ db: app }).cash_check;
    const ctx = { deadlineMs: now + 14_000, clock };
    const was = flags.cashFridayEnabled;
    try {
      // A check from before the event was first seen does not cover it: the handler goes on to the
      // check itself, which (switched off here) answers without storing a row.
      await check(randomUUID(), "2026-01-09T11:00:00.000Z", '[{"n":1}]');
      flags.cashFridayEnabled = false;
      expect(await handler.run(c.service, event, ctx)).toEqual({ outcome: "skipped", detail: { category: "switched_off" } });
      expect(await countChecks()).toBe(1);

      // One stored since (an earlier try whose done line was never written) covers it.
      const stored = randomUUID();
      await check(stored, "2026-01-09T12:05:00.000Z", '[{"n":1},{"n":2}]');
      flags.cashFridayEnabled = true;
      expect(await handler.run(c.service, event, ctx)).toEqual({ outcome: "done", detail: { runId: stored, found: 2 } });
      expect(await countChecks()).toBe(2);
    } finally {
      flags.cashFridayEnabled = was;
    }
  });
});

describe("the log", () => {
  it("is never changed, removed or emptied, by the app or the admin", async () => {
    const c = await carrier("desk-guard");
    await wake(c, recording([]));
    const t = c.fixture.tenantId;
    for (const db of [app, admin]) {
      for (const sql of [
        "UPDATE desk_log SET detail = CAST('{}' AS jsonb) WHERE tenant_id = current_tenant_id()",
        "DELETE FROM desk_log WHERE tenant_id = current_tenant_id()",
      ]) {
        const state = await sqlStateOf(db.withTenant(t, (q) => q.execute(sql)));
        expect(state, `${db === app ? "app" : "admin"}: ${sql}`).toBe(db === app ? "42501" : "23514");
      }
    }
    expect(await sqlStateOf(admin.withTenant(t, (q) => q.execute("TRUNCATE desk_log")))).toBe("23514");
    expect(await sqlStateOf(app.withTenant(t, (q) => q.execute("TRUNCATE desk_log")))).toBe("42501");
    expect((await linesOf(c)).length).toBeGreaterThan(0);
  });

  it("goes with its carrier, and another carrier sees none of it", async () => {
    const c = await carrier("desk-gone");
    const other = await carrier("desk-other");
    await wake(c, recording([]));
    const seenByOther = await app.withTenant(other.fixture.tenantId, (q) =>
      q.query<{ n: number }>(
        "SELECT CAST((SELECT count(*) FROM desk_log) + (SELECT count(*) FROM desk_loops) AS integer) AS n",
      ),
    );
    expect(seenByOther[0].n).toBe(0);
    const forged = app.withTenant(other.fixture.tenantId, (q) =>
      q.execute(
        `INSERT INTO desk_log (id, tenant_id, wake_id, kind, by)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), 'wake', 'schedule')`,
        [randomUUID(), c.fixture.tenantId, randomUUID()],
      ),
    );
    expect(await sqlStateOf(forged)).toBe("42501");

    await dropTenant(admin, c.fixture);
    made.splice(made.indexOf(c.fixture), 1);
    const left = await admin.withoutTenant((q) =>
      q.query<{ n: number }>(
        `SELECT CAST((SELECT count(*) FROM desk_log WHERE tenant_id = CAST($1 AS uuid))
                + (SELECT count(*) FROM desk_loops WHERE tenant_id = CAST($1 AS uuid)) AS integer) AS n`,
        [c.fixture.tenantId],
      ),
    );
    expect(left[0].n).toBe(0);
  });
});

describe("the panel", () => {
  it("counts what the loop did since it started, and says not read when the approval breaks fail to read", async () => {
    const c = await carrier("desk-panel");
    await payment(c, "2026-01-06T12:00:00.000Z");
    await wake(c, recording([]));
    const panel = await readDeskPanel(c.service, { db: app });
    expect(panel).toMatchObject({
      runningSince: "2026-01-06T15:00:00.000Z",
      eventsHandled: 3,
      problemsFound: 3,
      toolCalls: 0,
      proposalsWaiting: 0,
      approvalBreaks: 0,
      left: 0,
    });
    expect(panel.lastWake).toMatchObject({ at: "2026-01-06T15:00:00.000Z", handled: 3, skipped: 0 });
    const log = await readDeskLog(c.service, 5, { db: app });
    expect(log).toHaveLength(5);
    expect(log[0]).toMatchObject({ kind: "sleep", category: "no_work", found: 3 });

    const broken: TenantDb = {
      withTenant: async () => {
        throw new Error("connection reset");
      },
    };
    expect(await readApprovalBreaks(broken, c.service)).toBeNull();
    expect(await readApprovalBreaks(app, c.service)).toBe(0);
  });
});
