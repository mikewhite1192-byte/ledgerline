import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { openAgentTurn, readAgentTurn, readRecentAgentTurns } from "../agent/gateway/store";
import { readSpend, reserve, settle, type Reservation, type Spend } from "../ai/spend";
import { AiError } from "../ai/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import type { Session } from "./claims";
import {
  NANOCENTS_PER_CENT,
  countVisitTurn,
  readVisit,
  startVisit,
  type StartedVisit,
  type VisitLimits,
} from "./demo-visit";

// A demo visit against a real database, as the app's role: the new-visit limits per address and
// per day, a kept visit, the day's cap, the visit read getSession() makes, the turn count, a
// visit's conversations walled off from every other visit, and the visit's spend inside the
// spend ledger's lock (its own cap, the day's cap across visits, settles). Every instant is fixed
// (the visit read is the one exception: it uses the database clock, so its live visit is made
// now and its ended one years ago). Each area has its own tenant, so their counts never meet.
// The spend counter is global, so this file puts it back as it found it.

const V = randomUUID(); // new-visit limits
const R = randomUUID(); // the visit read
const T = randomUUID(); // turns and conversations
const S = randomUUID(); // spend
const OTHER = randomUUID(); // another carrier
const tag = V.slice(0, 8);
const JUDGE = (tenantId: string) => `judge-${tenantId}`;
const ADMIN = (tenantId: string) => `admin-${tenantId}`;
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

const LIMITS: VisitLimits = {
  sessionCapCents: 1,
  turnsPerSession: 2,
  dayCapCents: 2,
  sessionsPerIpPerHour: 2,
  sessionsPerDay: 6,
  cookieHours: 2,
};
const DAY1 = Date.UTC(2026, 10, 2, 15, 0, 0);
const DAY2 = Date.UTC(2026, 10, 3, 15, 0, 0);
const DAY3 = Date.UTC(2026, 10, 4, 15, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let admin: Db;
let app: Db;
let before: Spend | undefined;
const savedFlags = { ...flags.judgeAccess };

async function seed(tenantId: string, slug: string) {
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    for (const [sub, role] of [
      [JUDGE(tenantId), "judge"],
      [ADMIN(tenantId), "admin"],
    ]) {
      await q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, $3)",
        [sub, `${role}@${slug}.example`, role],
      );
    }
  });
}

function start(
  tenantId: string,
  at: number | null,
  over: { ipHash?: string | null; reuseId?: string | null; sub?: string; limits?: VisitLimits } = {},
): Promise<StartedVisit> {
  return app.withTenant(tenantId, (q) =>
    startVisit(q, {
      sub: over.sub ?? JUDGE(tenantId),
      ipHash: over.ipHash === undefined ? H1 : over.ipHash,
      reuseId: over.reuseId ?? null,
      limits: over.limits ?? LIMITS,
      at: at === null ? null : iso(at),
    }),
  );
}

async function visitId(tenantId: string, at: number | null, ipHash: string | null = H3): Promise<string> {
  const started = await start(tenantId, at, { ipHash, limits: { ...LIMITS, sessionsPerIpPerHour: 100, sessionsPerDay: 100 } });
  if (!started.ok) throw new Error(`no visit: ${started.reason}`);
  return started.id;
}

const visitRow = (tenantId: string, id: string) =>
  admin.withTenant(tenantId, async (q) => {
    const [row] = await q.query<Record<string, unknown>>(
      `SELECT cognito_sub, ip_hash, turns, spent_nanocents, reserved_nanocents,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS created,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS expires
         FROM demo_sessions WHERE id = CAST($1 AS uuid)`,
      [id],
    );
    return row;
  });

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  for (const [id, slug] of [
    [V, `visit-v-${tag}`],
    [R, `visit-r-${tag}`],
    [T, `visit-t-${tag}`],
    [S, `visit-s-${tag}`],
    [OTHER, `visit-o-${tag}`],
  ]) {
    await seed(id, slug);
  }
  before = await app.withTenant(S, (q) => readSpend(q));
});

afterAll(async () => {
  Object.assign(flags.judgeAccess, savedFlags);
  // Put the global counter back, then remove only this file's tenants (visits, conversations,
  // turns and calls go with them).
  const saved = before;
  if (saved) {
    await admin.withoutTenant((q) =>
      q.execute(
        `UPDATE ops.ai_spend
            SET spent_nanocents = CAST($1 AS bigint), reserved_nanocents = CAST($2 AS bigint),
                calls = CAST($3 AS bigint), wonder_spent_nanocents = CAST($4 AS bigint),
                wonder_reserved_nanocents = CAST($5 AS bigint)
          WHERE id = 1`,
        [
          saved.spentNanocents,
          saved.reservedNanocents,
          saved.calls,
          saved.wonderSpentNanocents,
          saved.wonderReservedNanocents,
        ],
      ),
    );
  }
  for (const id of [V, R, T, S, OTHER]) {
    await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
  }
  await app?.close();
  await admin?.close();
});

describe("starting a demo visit", () => {
  it("writes one row for the judge, with the address hashed and the visit's length", async () => {
    const started = await start(V, DAY1);
    expect(started).toMatchObject({ ok: true, reused: false });
    if (!started.ok) return;
    expect(await visitRow(V, started.id)).toEqual({
      cognito_sub: JUDGE(V),
      ip_hash: H1,
      turns: 0,
      spent_nanocents: 0,
      reserved_nanocents: 0,
      created: "2026-11-02T15:00:00",
      expires: "2026-11-02T17:00:00",
    });
  });

  it("holds new visits per address per hour, with every visit lacking an address in one bucket", async () => {
    expect(await start(V, DAY1 + MIN)).toMatchObject({ ok: true });
    expect(await start(V, DAY1 + 2 * MIN)).toEqual({ ok: false, reason: "ip_limit" });
    expect(await start(V, DAY1 + 2 * MIN, { ipHash: H2 })).toMatchObject({ ok: true });
    expect(await start(V, DAY1 + 3 * MIN, { ipHash: null })).toMatchObject({ ok: true });
    expect(await start(V, DAY1 + 3 * MIN, { ipHash: null })).toMatchObject({ ok: true });
    expect(await start(V, DAY1 + 4 * MIN, { ipHash: null })).toEqual({ ok: false, reason: "ip_limit" });
    // An hour after the first two, the address may start visits again.
    expect(await start(V, DAY1 + HOUR + 2 * MIN)).toMatchObject({ ok: true });
  });

  it("holds new visits per day, keeps a live visit past the limits, and never keeps an ended one", async () => {
    const first = await start(V, DAY2, { ipHash: H1 });
    if (!first.ok) throw new Error("no first visit");
    for (const [i, hash] of [H2, H3, null, "4".repeat(64), "5".repeat(64)].entries()) {
      expect(await start(V, DAY2 + (i + 1) * MIN, { ipHash: hash })).toMatchObject({ ok: true });
    }
    expect(await start(V, DAY2 + 10 * MIN, { ipHash: "6".repeat(64) })).toEqual({ ok: false, reason: "day_limit" });
    // The browser's own live visit is kept, at the day's limit and the address's.
    expect(await start(V, DAY2 + 10 * MIN, { reuseId: first.id })).toEqual({ ok: true, id: first.id, reused: true });
    // Not once it ended, not for another subject, not for a value that is not a visit id.
    for (const over of [
      { at: DAY2 + 2 * HOUR, reuseId: first.id },
      { at: DAY2 + 10 * MIN, reuseId: first.id, sub: ADMIN(V) },
      { at: DAY2 + 10 * MIN, reuseId: "not-a-visit" },
    ]) {
      expect(await start(V, over.at, { reuseId: over.reuseId, sub: over.sub })).toEqual({ ok: false, reason: "day_limit" });
    }
    // The next day counts afresh.
    expect(await start(V, DAY3, { ipHash: H1 })).toMatchObject({ ok: true });
  });

  it("starts or keeps nothing once the day's visits have spent the day's cap", async () => {
    const day = DAY3 + 4 * HOUR;
    const full = await start(V, day, { ipHash: H2 });
    if (!full.ok) throw new Error("no visit");
    await admin.withTenant(V, (q) =>
      q.execute("UPDATE demo_sessions SET spent_nanocents = CAST($2 AS bigint) WHERE id = CAST($1 AS uuid)", [
        full.id,
        LIMITS.dayCapCents * NANOCENTS_PER_CENT,
      ]),
    );
    expect(await start(V, day + MIN, { ipHash: H3 })).toEqual({ ok: false, reason: "day_cap" });
    expect(await start(V, day + MIN, { reuseId: full.id })).toEqual({ ok: false, reason: "day_cap" });
  });
});

describe("reading a demo visit for the session", () => {
  it("names the subject's role and whether the visit is theirs and live", async () => {
    const live = await visitId(R, null);
    const ended = await visitId(R, Date.UTC(2020, 0, 6, 15, 0, 0));
    const read = (sub: string, id: string, tenantId = R) => app.withTenant(tenantId, (q) => readVisit(q, sub, id));
    expect(await read(JUDGE(R), live)).toEqual({ role: "judge", live: true });
    expect(await read(JUDGE(R), ended)).toEqual({ role: "judge", live: false });
    expect(await read(ADMIN(R), live)).toEqual({ role: "admin", live: false });
    expect(await read("nobody", live)).toEqual({ role: null, live: false });
    expect(await read(JUDGE(R), randomUUID())).toEqual({ role: "judge", live: false });
    // Another carrier's judge, in its own carrier's transaction, cannot see this visit.
    expect(await read(JUDGE(OTHER), live, OTHER)).toEqual({ role: "judge", live: false });
  });
});

describe("a demo visit's agent turns", () => {
  const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);
  const judge = (demoSessionId?: string): Session => ({ sub: JUDGE(T), email: "", tenantId: T, demoSessionId });

  function open(session: Session, conversationId: string | null = null, at = T0) {
    return openAgentTurn(
      session,
      { conversationId, turnId: randomUUID(), text: "How is pay worked out?", now: new Date(at), summaryChars: 10_000 },
      { db: app, clock: () => new Date(at) },
    );
  }

  const conversationsOf = (id: string) =>
    admin.withTenant(T, async (q) => {
      const [row] = await q.query<{ n: number }>(
        "SELECT CAST(COUNT(*) AS integer) AS n FROM conversations WHERE demo_session_id = CAST($1 AS uuid)",
        [id],
      );
      return row.n;
    });

  it("counts turns against the visit, refusing an ended visit and another subject's", async () => {
    const id = await visitId(T, T0 - MIN);
    const count = (at: number, sub = JUDGE(T)) =>
      app.withTenant(T, (q) => countVisitTurn(q, { visitId: id, sub, turnsPerSession: 2, at: iso(at) }));
    expect(await count(T0)).toBe("ok");
    expect(await count(T0 + MIN)).toBe("ok");
    expect(await count(T0 + 2 * MIN)).toBe("visit_used");
    expect(await count(T0 + 3 * MIN, ADMIN(T))).toBe("visit_ended");
    expect(await count(T0 + 2 * HOUR)).toBe("visit_ended");
    expect(await visitRow(T, id)).toMatchObject({ turns: 2 });
  });

  it("walls a visit's conversations off from every other visit and from the login without one", async () => {
    flags.judgeAccess.enabled = true;
    flags.judgeAccess.turnsPerSession = 25;
    const a = await visitId(T, T0 - MIN);
    const b = await visitId(T, T0 - MIN);
    const opened = await open(judge(a));
    if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
    expect(await conversationsOf(a)).toBe(1);

    expect(await open(judge(b), opened.conversationId, T0 + MIN)).toEqual({ refused: "not_found" });
    expect(await open(judge(), opened.conversationId, T0 + MIN)).toEqual({ refused: "not_found" });
    expect(await readAgentTurn(judge(b), opened.turnId, { db: app })).toBeNull();
    expect(await readAgentTurn(judge(), opened.turnId, { db: app })).toBeNull();
    expect((await readRecentAgentTurns(judge(b), { db: app })).map((t) => t.id)).not.toContain(opened.turnId);
    expect(await readAgentTurn(judge(a), opened.turnId, { db: app })).not.toBeNull();
    expect((await readRecentAgentTurns(judge(a), { db: app })).map((t) => t.id)).toContain(opened.turnId);
    // A refused turn counted nothing.
    expect(await visitRow(T, b)).toMatchObject({ turns: 0 });
  });

  it("opens nothing past the visit's turns, after it ended, or with the switch off", async () => {
    flags.judgeAccess.enabled = true;
    flags.judgeAccess.turnsPerSession = 1;
    const id = await visitId(T, T0 - MIN);
    const first = await open(judge(id));
    expect("refused" in first).toBe(false);
    expect(await open(judge(id), null, T0 + MIN)).toEqual({ refused: "visit_used" });
    expect(await conversationsOf(id)).toBe(1);

    flags.judgeAccess.turnsPerSession = 25;
    expect(await open(judge(id), null, T0 + 2 * HOUR)).toEqual({ refused: "visit_ended" });
    flags.judgeAccess.enabled = false;
    expect(await open(judge(id), null, T0 + 2 * MIN)).toEqual({ refused: "visit_ended" });
    expect(await conversationsOf(id)).toBe(1);
    expect(await visitRow(T, id)).toMatchObject({ turns: 1 });
  });
});

describe("a demo visit's model spend", () => {
  const AT = Date.UTC(2026, 10, 2, 15, 0, 0);
  const HALF = NANOCENTS_PER_CENT / 2;
  const judge = (demoSessionId?: string): Session => ({ sub: JUDGE(S), email: "", tenantId: S, demoSessionId });
  const adminSession: Session = { sub: ADMIN(S), email: "", tenantId: S };

  const reservation = (nanocents: number, at = AT): Reservation => ({
    callId: randomUUID(),
    target: "spark",
    provider: "meta",
    model: "muse-spark-1.3",
    kind: "text",
    purpose: "proof",
    reasoningEffort: "low",
    traceId: null,
    reserveNanocents: nanocents,
    capNanocents: Number.MAX_SAFE_INTEGER,
    wonderCapNanocents: null,
    jobCapNanocents: Number.MAX_SAFE_INTEGER,
    at: iso(at),
  });

  const answered = (costNanocents: number) => ({
    kind: "answered" as const,
    status: "ok" as const,
    usage: { input: 10, cached: 0, output: 20, reasoning: 0 },
    units: null,
    costNanocents,
    upstreamId: "resp_visit",
    httpStatus: 200,
    durationMs: 100,
  });

  const callExists = (callId: string) =>
    admin.withTenant(S, async (q) => (await q.query("SELECT 1 FROM model_calls WHERE id = CAST($1 AS uuid)", [callId])).length === 1);

  async function refusedWith(work: Promise<unknown>): Promise<string> {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).category;
  }

  beforeAll(() => {
    Object.assign(flags.judgeAccess, { enabled: true, sessionCapCents: 1, dayCapCents: 2 });
  });

  it("reserves within the visit's cap, refuses past it with no call row, and settles into the visit", async () => {
    const id = await visitId(S, AT - MIN);
    const r1 = reservation(HALF);
    const r2 = reservation(HALF);
    await reserve(app, judge(id), r1);
    await reserve(app, judge(id), r2);
    const counter = await app.withTenant(S, (q) => readSpend(q));
    const r3 = reservation(1);
    expect(await refusedWith(reserve(app, judge(id), r3))).toBe("cap");
    expect(await callExists(r3.callId)).toBe(false);
    expect(await app.withTenant(S, (q) => readSpend(q))).toEqual(counter);
    expect(await visitRow(S, id)).toMatchObject({ reserved_nanocents: 2 * HALF, spent_nanocents: 0 });

    // An answer below its reservation releases the difference to the visit.
    expect(await settle(app, judge(id), r1.callId, answered(100_000_000))).toBe(true);
    expect(await visitRow(S, id)).toMatchObject({ reserved_nanocents: HALF, spent_nanocents: 100_000_000 });
    await reserve(app, judge(id), reservation(400_000_000));
    expect(await refusedWith(reserve(app, judge(id), reservation(1)))).toBe("cap");
    // A refused call releases its reservation and spends nothing.
    expect(await settle(app, judge(id), r2.callId, { kind: "refused", category: "unavailable", httpStatus: 503, durationMs: 5 })).toBe(true);
    expect(await visitRow(S, id)).toMatchObject({ reserved_nanocents: 400_000_000, spent_nanocents: 100_000_000 });
  });

  it("gives each visit its own budget, and holds the day's cap across every visit", async () => {
    // The first test left 0.5 cents counted today; the day's cap is 2 cents.
    const second = await visitId(S, AT - MIN);
    const third = await visitId(S, AT - MIN);
    const fourth = await visitId(S, AT - MIN);
    await reserve(app, judge(second), reservation(HALF));
    await reserve(app, judge(third), reservation(NANOCENTS_PER_CENT));
    const r = reservation(1);
    expect(await refusedWith(reserve(app, judge(fourth), r))).toBe("cap");
    expect(await callExists(r.callId)).toBe(false);
    expect(await visitRow(S, fourth)).toMatchObject({ reserved_nanocents: 0 });
    // A visit created the next day starts a new day's cap.
    const tomorrow = await visitId(S, AT + 24 * HOUR);
    await reserve(app, judge(tomorrow), reservation(HALF, AT + 24 * HOUR + MIN));
  });

  it("refuses a judge with no visit, an ended visit, and any visit with the switch off", async () => {
    const id = await visitId(S, AT + 48 * HOUR);
    expect(await refusedWith(reserve(app, judge(), reservation(1, AT + 48 * HOUR + MIN)))).toBe("cap");
    expect(await refusedWith(reserve(app, judge(id), reservation(1, AT + 51 * HOUR)))).toBe("cap");
    flags.judgeAccess.enabled = false;
    try {
      expect(await refusedWith(reserve(app, judge(id), reservation(1, AT + 48 * HOUR + MIN)))).toBe("cap");
    } finally {
      flags.judgeAccess.enabled = true;
    }
    expect(await visitRow(S, id)).toMatchObject({ reserved_nanocents: 0, spent_nanocents: 0 });
  });

  it("leaves admin spend as it was: no visit, no visit check", async () => {
    const r = reservation(HALF, AT + 72 * HOUR);
    await reserve(app, adminSession, r);
    expect(await settle(app, adminSession, r.callId, answered(1_000))).toBe(true);
    expect(await callExists(r.callId)).toBe(true);
  });
});
