import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { ReadLimitError, readTable } from "../data/read";
import type { Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { quarterOf } from "../rules-engine";
import { DEMO_CARRIERS } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { localDateOf, quarterContaining } from "../time/local-date";
import { MAX_QUARTER_ROWS, readQuarterInput } from "./quarter-figures";
import { readQuarterReviews, readQuarterView } from "./quarter-review";
import { writeQuarterReview, type QuarterCompleteFn, type WriteQuarterDeps } from "./write-quarter";

// The quarter review against the real database, as the app's role, on the seeded Blue Ridge
// carrier, with a fake model. A review is
// reserved before its one Wonder call and drafted only when every number in every list passes the
// check; a press while one is out, or after one passed, writes nothing; a failed review keeps no
// words and can be written again, the old row superseded; a timeout is refused, never stored as a
// review, and the figures page keeps working; the switch is checked again right before the call;
// the database keeps the lists final; and another carrier sees none of it. The recovery lines and
// detention charges are read only for the quarter so far, on the carrier's own dates, and more
// than the bound is a refusal, never a part. Only this file's three tenants are made, and they are
// removed after.

const [BR] = DEMO_CARRIERS;
const PLAN = buildCarrierPlan(BR, golden.anchor);
const NOW = Date.UTC(2026, 10, 2, 17, 0, 0);
const clock = () => new Date(NOW);
const TODAY = localDateOf(new Date(NOW).toISOString(), BR.timezone);
const QUARTER = quarterContaining(TODAY);
const saved = { ...flags, quarterReviewLimits: { ...flags.quarterReviewLimits } };

let admin: Db;
let app: Db;
const tenantId = randomUUID();
const session: Session = { sub: `sub-${tenantId}`, email: "", tenantId };
let B: Fixture;

// What the fake model saw.
let seen: AiRequest[] = [];

// The call's row in the model ledger, as complete() writes it before it returns the call's id.
async function ledgerRow(q: Queryable, id: string, purpose: string, traceId: string | null) {
  await q.execute(
    `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
       reserved_nanocents, cost_nanocents)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'wonder', 'meta', 'test-model', 'text', $2,
       CAST($3 AS uuid), 'ok', 0, 0)`,
    [id, purpose, traceId],
  );
}

async function answer(request: AiRequest, s: Session, text: string, status: AiResult["status"] = "ok"): Promise<AiResult> {
  seen.push(request);
  const callId = randomUUID();
  await admin.withTenant(s.tenantId, (q) => ledgerRow(q, callId, request.purpose, request.traceId ?? null));
  return {
    callId,
    status,
    text,
    toolCalls: [],
    usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
    costNanocents: 0,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

// The figure a line of the prompt's list names, written with its tag: "$48,210.00 [f9]".
function cite(request: AiRequest, label: string): string {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const line = user.split("\n").find((l) => l.includes(`] ${label}: `));
  const m = line ? /^\[(f\d+)\] .+?: (.+)$/.exec(line) : null;
  if (!m) throw new Error(`the figures have no ${label}`);
  return `${m[2]} [${m[1]}]`;
}

function lists(request: AiRequest, recovered?: string): string {
  const c = (label: string) => cite(request, label);
  return JSON.stringify({
    went_well: [`Margin on priced loads was ${c("Margin on priced loads")} so far.`],
    problems: [`Paystubs with a problem so far: ${c("Paystubs with a problem")}.`],
    recovered: [recovered ?? `Advances recovered from pay came to ${c("Advances recovered from pay")}.`],
    change: [
      `Collect the open receivables past due, ${c("Open receivables past due")}.`,
      `Bill the detention not billed so far, ${c("Detention not billed")}.`,
      `Look into the paystub problems found, ${c("Paystub problems found")}.`,
    ],
  });
}

// Copies figures exactly, each with its tag, so a good answer passes on its own numbers.
const goodModel: QuarterCompleteFn = async (_target, request, s) => answer(request, s, lists(request));
// One item with a number that cites nothing.
const untaggedModel: QuarterCompleteFn = async (_target, request, s) =>
  answer(request, s, lists(request, `Advances recovered from pay came to ${cite(request, "Advances recovered from pay")}, out of $2,000.00 taken.`));

const press = (complete: QuarterCompleteFn = goodModel, more: WriteQuarterDeps = {}) =>
  writeQuarterReview(session, { db: app, complete, clock, log: () => {}, ...more });

type Row = {
  id: string;
  status: string;
  kind: string;
  model: string | null;
  period_start: string;
  period_end: string;
  as_of: string;
  body: Record<string, string[]> | null;
  refusal_category: string | null;
  verification: { category: string | null } | null;
  model_call_id: string | null;
  trace_id: string | null;
};

// The clock is fixed, so rows sort by status and reason, not by when they were made.
async function rows(): Promise<Row[]> {
  return admin.withTenant(tenantId, (q) =>
    q.query<Row>(
      `SELECT CAST(id AS text) AS id, status, kind, model, CAST(period_start AS text) AS period_start,
              CAST(period_end AS text) AS period_end, CAST(as_of AS text) AS as_of, body, refusal_category,
              verification, CAST(model_call_id AS text) AS model_call_id, CAST(trace_id AS text) AS trace_id
         FROM briefs WHERE tenant_id = current_tenant_id() ORDER BY created_at, status, refusal_category`,
    ),
  );
}

const view = () =>
  app.withTenant(tenantId, (q) => readQuarterView(q, TODAY, BR.timezone, flags.quarterReviewLimits.maxInputChars, clock()));

describe("quarter reviews", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug = $1", [BR.slug]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${BR.slug} already exists: the database tests need a fresh database (npm run test:db:fresh)`,
      );
    }
    await admin.withTenant(tenantId, (q) =>
      q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        BR.slug,
        BR.name,
        BR.timezone,
      ]),
    );
    await replaceTenantData(app, tenantId, PLAN);
    await admin.withTenant(tenantId, (q) =>
      q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
        [session.sub, `ops@${BR.slug}.example`],
      ),
    );
    B = await makeTenant(admin, `quarter-${randomUUID().slice(0, 8)}`);
  });

  beforeEach(async () => {
    Object.assign(flags, saved, {
      quarterReviewLimits: { ...saved.quarterReviewLimits },
      quarterReviewEnabled: true,
      aiEnabled: true,
    });
    seen = [];
    for (const id of [tenantId, B?.tenantId]) {
      if (!id) continue;
      await admin.withTenant(id, async (q) => {
        await q.execute("DELETE FROM briefs WHERE tenant_id = current_tenant_id()");
        await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
      });
    }
  });

  afterEach(() => {
    Object.assign(flags, saved, { quarterReviewLimits: { ...saved.quarterReviewLimits } });
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    for (const id of [tenantId, B?.tenantId]) {
      if (!id) continue;
      // Reviews first: each names its model call.
      await admin?.withTenant(id, async (q) => {
        await q.execute("DELETE FROM briefs WHERE tenant_id = current_tenant_id()");
        await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
      });
    }
    await admin?.withTenant(tenantId, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("reserves the review, asks Wonder once, and drafts it only after every item passes the check", async () => {
    expect(QUARTER).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    const out = await press();
    expect(out).toMatchObject({ ok: true, status: "drafted", category: null });
    expect(seen).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: "drafted",
      kind: "quarter",
      model: "wonder",
      period_start: QUARTER.start,
      period_end: QUARTER.end,
      as_of: TODAY,
      refusal_category: null,
      verification: { category: null },
    });
    expect(Object.keys(row.body ?? {}).sort()).toEqual(["change", "problems", "recovered", "went_well"]);
    expect(row.body?.change).toHaveLength(3);
    expect(row.trace_id).toBe(seen[0].traceId);
    const calls = await admin.withTenant(tenantId, (q) =>
      q.query<{ id: string; target: string }>(
        "SELECT CAST(id AS text) AS id, target FROM model_calls WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(calls).toEqual([{ id: row.model_call_id, target: "wonder" }]);
    // The page reads it back as drafted, its figures unchanged.
    expect((await view()).review).toMatchObject({ kind: "drafted", changed: false });
    // A second press finds it written and asks nothing.
    expect(await press()).toEqual({ ok: false, category: "exists" });
    expect(seen).toHaveLength(1);
  });

  it("refuses before any model call when either switch is off", async () => {
    flags.quarterReviewEnabled = false;
    expect(await press()).toEqual({ ok: false, category: "disabled" });
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = false;
    expect(await press()).toEqual({ ok: false, category: "ai_disabled" });
    expect(seen).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });

  it("a review with an untagged number keeps no words, and the next press supersedes it", async () => {
    expect(await press(untaggedModel)).toMatchObject({ ok: true, status: "refused", category: "untagged" });
    const [refused] = await rows();
    expect(refused).toMatchObject({ status: "refused", refusal_category: "untagged", body: null, verification: { category: "untagged" } });
    expect(refused.model_call_id).not.toBeNull();
    expect((await view()).review).toEqual({ kind: "refused", category: "untagged" });
    expect(await press()).toMatchObject({ ok: true, status: "drafted" });
    const after = await rows();
    expect(after.map((r) => [r.id === refused.id, r.status, r.refusal_category, r.body === null])).toEqual([
      [false, "drafted", null, false],
      [true, "superseded", "untagged", true],
    ]);
  });

  it("a Wonder timeout stores refused with category timeout and leaves the figures page working", async () => {
    const timedOut: QuarterCompleteFn = async () => {
      throw new AiError("timeout");
    };
    expect(await press(timedOut)).toMatchObject({ ok: true, status: "refused", category: "timeout" });
    expect((await rows()).map((r) => [r.status, r.refusal_category, r.body, r.model_call_id])).toEqual([
      ["refused", "timeout", null, null],
    ]);
    const page = await view();
    expect(page.quarter.pay.runs).toBeGreaterThan(0);
    expect(page.packed.length).toBeGreaterThan(0);
    expect(page.review).toEqual({ kind: "refused", category: "timeout" });
  });

  it("leaves a call turned down before any request over_cap, a server error or a cut-off reply refused, and all can be written again", async () => {
    const turnedDown: QuarterCompleteFn = async () => {
      throw new AiError("cap");
    };
    expect(await press(turnedDown)).toEqual({ ok: true, briefId: expect.any(String), status: "over_cap", category: "cap" });
    const serverError: QuarterCompleteFn = async () => {
      throw new AiError("unavailable", 503);
    };
    expect(await press(serverError)).toMatchObject({ ok: true, status: "refused", category: "unavailable" });
    const cutOff: QuarterCompleteFn = async (_t, request, s) => answer(request, s, '{"went_well": ["Margin', "incomplete");
    expect(await press(cutOff)).toMatchObject({ ok: true, status: "refused", category: "incomplete" });
    expect(await press()).toMatchObject({ ok: true, status: "drafted" });
    expect((await rows()).map((r) => [r.status, r.refusal_category, r.body === null, r.model_call_id === null])).toEqual([
      ["drafted", null, false, false],
      ["superseded", "cap", true, true],
      ["superseded", "incomplete", true, false],
      ["superseded", "unavailable", true, true],
    ]);
  });

  it("writes one review when two presses arrive at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: QuarterCompleteFn = async (target, request, s) => {
      await gate;
      return goodModel(target, request, s);
    };
    const first = press(slow);
    const second = press(slow);
    const loser = await Promise.race([first, second]);
    expect(loser).toEqual({ ok: false, category: "in_progress" });
    release();
    const outs = await Promise.all([first, second]);
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect((await rows()).map((r) => r.status)).toEqual(["drafted"]);
  });

  it("checks the switch again right before the model call", async () => {
    let ids = 0;
    const newId = () => {
      ids += 1;
      // The trace id is the reservation's last id: the switch goes off just after it is drawn.
      if (ids === 2) flags.quarterReviewEnabled = false;
      return randomUUID();
    };
    expect(await press(goodModel, { newId })).toMatchObject({ ok: true, status: "over_cap", category: "disabled" });
    expect(seen).toHaveLength(0);
    expect((await rows()).map((r) => [r.status, r.refusal_category, r.model_call_id])).toEqual([["over_cap", "disabled", null]]);
  });

  it("another carrier cannot read the review", async () => {
    expect(await press()).toMatchObject({ ok: true, status: "drafted" });
    const [mine] = await rows();
    const seenByB = await app.withTenant(B.tenantId, async (q) => ({
      table: await readTable(q, "briefs"),
      quarter: await readQuarterReviews(q, QUARTER.start),
      counted: await q.query<{ n: number }>("SELECT count(*)::int AS n FROM briefs"),
      changed: await q.execute("UPDATE briefs SET status = 'superseded' WHERE id = CAST($1 AS uuid)", [mine.id]),
    }));
    expect(seenByB).toEqual({ table: [], quarter: [], counted: [{ n: 0 }], changed: 0 });
    // B's member cannot write into A's carrier either.
    await expect(writeQuarterReview({ ...B.session, tenantId }, { db: app, complete: goodModel, clock })).rejects.toThrow();
    expect((await rows()).map((r) => r.status)).toEqual(["drafted"]);
  });

  it("keeps a review's lists final in the database", async () => {
    expect(await press()).toMatchObject({ ok: true, status: "drafted" });
    const [row] = await rows();
    const asApp = (sql: string, params: unknown[] = []) =>
      sqlStateOf(app.withTenant(tenantId, (q) => q.execute(sql, params as never[])));
    expect(
      await asApp(`UPDATE briefs SET body = CAST('{"went_well":["x"]}' AS jsonb) WHERE id = CAST($1 AS uuid)`, [row.id]),
    ).toBe("23514");
    expect(await asApp("UPDATE briefs SET status = 'superseded' WHERE id = CAST($1 AS uuid)", [row.id])).toBe("23514");
    expect(await asApp("UPDATE briefs SET figures = CAST('[]' AS jsonb) WHERE id = CAST($1 AS uuid)", [row.id])).toBe("42501");
    // One live review a quarter.
    expect(
      await asApp(
        `INSERT INTO briefs (tenant_id, kind, period_start, period_end, as_of, status, figures, model, created_by)
         VALUES (current_tenant_id(), 'quarter', CAST($1 AS date), CAST($2 AS date), CAST($3 AS date),
           'drafting', CAST('[]' AS jsonb), 'wonder', 'x')`,
        [QUARTER.start, QUARTER.end, TODAY],
      ),
    ).toBe("23505");
  });

  // The two reads the money recovered is summed from, on a carrier of their own in makeTenant's
  // zone, America/Chicago: UTC-5 on Oct 1 and UTC-6 on Nov 2, after the clocks go back on Nov 1.
  // Four pay runs, each with one paystub holding one advance recovery: before the quarter, begun in
  // the last quarter's final days and ending in this one, inside it, and starting after asOf. Five
  // detention fixes, done: one in June and one either side of the quarter's first day and of asOf,
  // on the carrier's clock.
  describe("the quarter's recovery lines and detention charges", () => {
    const ZONE = "America/Chicago";
    const loadId = randomUUID();
    const stubs = { before: randomUUID(), begunEarlier: randomUUID(), inside: randomUUID(), afterAsOf: randomUUID() };
    // Paystub, run start, run end, run status, paystub status, recovery cents (a deduction, below zero).
    const RUNS: [string, string, string, string, string, number][] = [
      [stubs.before, "2026-09-14", "2026-09-20", "paid", "paid", -1_100],
      [stubs.begunEarlier, "2026-09-28", "2026-10-04", "paid", "paid", -2_200],
      [stubs.inside, "2026-10-12", "2026-10-18", "approved", "approved", -3_300],
      [stubs.afterAsOf, "2026-11-09", "2026-11-15", "open", "draft", -4_400],
    ];
    const fixes = { june: randomUUID(), dayBefore: randomUUID(), firstDay: randomUUID(), lastDay: randomUUID(), dayAfter: randomUUID() };
    // Fix, its charge, decided at (UTC), the carrier's date then, cents.
    const CHARGES: [string, string, string, string, number][] = [
      [fixes.june, randomUUID(), "2026-06-15T15:00:00.000Z", "2026-06-15", 1_000],
      [fixes.dayBefore, randomUUID(), "2026-10-01T04:30:00.000Z", "2026-09-30", 2_000],
      [fixes.firstDay, randomUUID(), "2026-10-01T05:30:00.000Z", "2026-10-01", 3_000],
      [fixes.lastDay, randomUUID(), "2026-11-03T05:30:00.000Z", "2026-11-02", 4_000],
      [fixes.dayAfter, randomUUID(), "2026-11-03T06:30:00.000Z", "2026-11-03", 5_000],
    ];
    // When every fix the bound tests add was decided: inside the quarter.
    const BULK_DECIDED = "2026-10-15T15:00:00.000Z";
    let C: Fixture;

    const input = () => app.withTenant(C.tenantId, (q) => readQuarterInput(q, QUARTER, TODAY, ZONE));
    const pageRead = () =>
      app.withTenant(C.tenantId, (q) => readQuarterView(q, TODAY, ZONE, flags.quarterReviewLimits.maxInputChars, clock()));

    // A done detention fix and the charge it billed on the load. Written as an engine proposal, so
    // it needs no turn: the read does not look at who suggested the fix.
    async function addFix(q: Queryable, [fix, charge, decidedAt, , cents]: (typeof CHARGES)[number], seq: number) {
      await q.execute(
        `INSERT INTO proposals (id, tenant_id, origin, kind, subject_table, subject_id, amount_cents, direction, title,
           args, operator_verdict, dedupe_key, status, decided_by, decided_at, created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'engine', 'detention_charge', 'loads', CAST($2 AS uuid), $3,
           'in', 'Bill unbilled detention', CAST('{}' AS jsonb), 'not_given', $4, 'done', 'ops',
           CAST($5 AS timestamptz), CAST($5 AS timestamptz), CAST($5 AS timestamptz))`,
        [fix, loadId, cents, `detention_charge:${loadId}:${fix.replaceAll("-", "")}${charge.replaceAll("-", "")}`, decidedAt],
      );
      await q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, description, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention', $3, $4, 'Detention',
           CAST($5 AS uuid))`,
        [charge, loadId, seq, cents, fix],
      );
    }

    // n more advance recoveries on the inside run's paystub, numbered from `from` (their seq).
    const addRecoveries = (from: number, n: number) =>
      admin.withTenant(C.tenantId, (q) =>
        q.execute(
          `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
           SELECT gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), g.i, 'advance_recovery',
             'Advance recovery', -1, CAST('[]' AS jsonb)
             FROM generate_series(CAST($2 AS integer), CAST($3 AS integer)) AS g(i)`,
          [stubs.inside, from, from + n - 1],
        ),
      );

    // n more done fixes, each with its charge, decided inside the quarter, numbered from `from` (each
    // charge's seq on the load).
    const addFixes = (from: number, n: number) =>
      admin.withTenant(C.tenantId, async (q) => {
        const range = [loadId, from, from + n - 1, BULK_DECIDED];
        await q.execute(
          `INSERT INTO proposals (id, tenant_id, origin, kind, subject_table, subject_id, amount_cents, direction, title,
             args, operator_verdict, dedupe_key, status, decided_by, decided_at, created_at, updated_at)
           SELECT CAST(md5(CAST(current_tenant_id() AS text) || 'fix' || g.i) AS uuid), current_tenant_id(), 'engine',
             'detention_charge', 'loads', CAST($1 AS uuid), 100, 'in', 'Bill unbilled detention',
             CAST('{}' AS jsonb), 'not_given',
             'detention_charge:' || CAST(CAST($1 AS uuid) AS text) || ':' || md5('a' || g.i) || md5('b' || g.i),
             'done', 'ops', CAST($4 AS timestamptz), CAST($4 AS timestamptz), CAST($4 AS timestamptz)
             FROM generate_series(CAST($2 AS integer), CAST($3 AS integer)) AS g(i)`,
          range,
        );
        await q.execute(
          `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, description, proposal_id)
           SELECT CAST(md5(CAST(current_tenant_id() AS text) || 'charge' || g.i) AS uuid), current_tenant_id(),
             CAST($1 AS uuid), 'detention', g.i, 100, 'Detention',
             CAST(md5(CAST(current_tenant_id() AS text) || 'fix' || g.i) AS uuid)
             FROM generate_series(CAST($2 AS integer), CAST($3 AS integer)) AS g(i)`,
          range.slice(0, 3),
        );
      });

    beforeAll(async () => {
      C = await makeTenant(admin, `quarter-reads-${randomUUID().slice(0, 8)}`);
      const payConfig = randomUUID();
      await admin.withTenant(C.tenantId, async (q) => {
        await q.execute(
          `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
             empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
             escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
             advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
             0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
          [payConfig],
        );
        for (const [stub, start, end, runStatus, stubStatus, cents] of RUNS) {
          const period = randomUUID();
          await q.execute(
            `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($3 AS date), $4)`,
            [period, start, end, runStatus],
          );
          await q.execute(
            `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
               deductions_cents, net_cents, paid_at)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
               100000, $6, $7, CAST($8 AS timestamptz))`,
            [stub, period, C.driverId, payConfig, stubStatus, -cents, 100_000 + cents, stubStatus === "paid" ? `${end}T15:00:00.000Z` : null],
          );
          await q.execute(
            `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'advance_recovery', 'Advance recovery',
               $3, CAST('[]' AS jsonb))`,
            [randomUUID(), stub, cents],
          );
        }
        // One load, delivered before the quarter, so only its detention charges are in play.
        await q.execute(
          `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
             dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-1', CAST($2 AS uuid), CAST($3 AS uuid), 'delivered',
             'Springfield', 'IL', 'Dayton', 'OH', CAST('2026-06-10' AS date), CAST('2026-06-11' AS date),
             CAST('2026-06-11T16:00:00Z' AS timestamptz), 480, 150000)`,
          [loadId, C.customerId, C.driverId],
        );
        for (const [i, charge] of CHARGES.entries()) await addFix(q, charge, i + 1);
      });
    });

    // The bound tests add rows past the fixture; each test starts from the fixture alone.
    afterEach(async () => {
      if (!C) return;
      await admin.withTenant(C.tenantId, async (q) => {
        await q.execute("DELETE FROM settlement_lines WHERE tenant_id = current_tenant_id() AND seq > 1");
        await q.execute("DELETE FROM load_accessorials WHERE tenant_id = current_tenant_id() AND seq > $1", [
          CHARGES.length,
        ]);
        await q.execute(
          "DELETE FROM proposals WHERE tenant_id = current_tenant_id() AND decided_at = CAST($1 AS timestamptz)",
          [BULK_DECIDED],
        );
      });
    });

    afterAll(async () => {
      await dropTenant(admin, C);
    });

    it("reads the recovery lines of only the pay runs the quarter counts, a run begun last quarter included", async () => {
      expect([QUARTER, TODAY]).toEqual([{ start: "2026-10-01", end: "2026-12-31" }, "2026-11-02"]);
      const { lines } = await input();
      expect(lines.map((l) => [l.settlementId, l.amountCents]).sort()).toEqual(
        [
          [stubs.begunEarlier, -2_200],
          [stubs.inside, -3_300],
        ].sort(),
      );
    });

    it("reads the detention fixes decided on the carrier's own dates from the quarter's first day to asOf", async () => {
      const { detention } = await input();
      expect(detention.map((d) => [d.proposalId, d.decidedOn, d.amountCents]).sort()).toEqual(
        [
          [fixes.firstDay, "2026-10-01", 3_000],
          [fixes.lastDay, "2026-11-02", 4_000],
        ].sort(),
      );
    });

    it("leaves out only rows the engine drops: given them back, every figure is the same", async () => {
      const read = await input();
      const readLines = new Set(read.lines.map((l) => l.settlementId));
      const readFixes = new Set(read.detention.map((d) => d.proposalId));
      const whole = {
        ...read,
        lines: [
          ...read.lines,
          ...RUNS.filter(([stub]) => !readLines.has(stub)).map(([stub, , , , , cents]) => ({
            settlementId: stub,
            kind: "advance_recovery",
            amountCents: cents,
          })),
        ],
        detention: [
          ...read.detention,
          ...CHARGES.filter(([fix]) => !readFixes.has(fix)).map(([fix, charge, , on, cents]) => ({
            id: charge,
            loadId,
            amountCents: cents,
            proposalId: fix,
            proposalStatus: "done",
            decidedOn: on,
          })),
        ],
      };
      expect([whole.lines.length, whole.detention.length]).toEqual([RUNS.length, CHARGES.length]);
      const counted = quarterOf(read, QUARTER, TODAY);
      expect(quarterOf(whole, QUARTER, TODAY)).toEqual(counted);
      expect(counted.recovered).toMatchObject({ advancesCents: 5_500, detentionCount: 2, detentionCents: 7_000 });
    });

    it("reads a full bound of recovery lines, the runs outside the quarter aside, and refuses one more", async () => {
      // Two lines are in the quarter already.
      await addRecoveries(2, MAX_QUARTER_ROWS - 2);
      expect((await input()).lines).toHaveLength(MAX_QUARTER_ROWS);
      await addRecoveries(MAX_QUARTER_ROWS, 1);
      await expect(input()).rejects.toBeInstanceOf(ReadLimitError);
      // The quarter page's read stops the same way, and the page shows a read past its bound as
      // unreadable, never as part of the quarter.
      await expect(pageRead()).rejects.toMatchObject({ category: "too_many_rows" });
    }, 60_000);

    it("reads a full bound of detention charges, the fixes decided outside the quarter aside, and refuses one more", async () => {
      // Two fixes are in the quarter already.
      await addFixes(CHARGES.length + 1, MAX_QUARTER_ROWS - 2);
      expect((await input()).detention).toHaveLength(MAX_QUARTER_ROWS);
      await addFixes(CHARGES.length + MAX_QUARTER_ROWS, 1);
      await expect(input()).rejects.toBeInstanceOf(ReadLimitError);
      await expect(pageRead()).rejects.toMatchObject({ category: "too_many_rows" });
    }, 60_000);
  });
});
