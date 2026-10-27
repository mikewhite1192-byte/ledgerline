import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readTable } from "../data/read";
import type { Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { DEMO_CARRIERS } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { localDateOf } from "../time/local-date";
import { closedWeeks } from "./figures";
import { BRIEF_LEASE_MS, readProfitBriefs, readProfitView } from "./view";
import { writeBrief, type CompleteFn } from "./write";

// The profit brief against the real database, as the app's role, on the seeded Blue Ridge carrier,
// with a fake model. A brief is reserved before its one model call and drafted only when every
// number passes the check; a press while one is out, or after one passed, writes nothing; a failed
// brief keeps no words and can be written again, the old row superseded; a brief left drafting
// past its lease is marked refused on the next press; the switch is checked again right before the
// call; the database keeps a brief's words final and its figures fixed; and another carrier sees
// none of it. Only this file's two tenants are made, and they are removed after.

const [BR] = DEMO_CARRIERS;
const PLAN = buildCarrierPlan(BR, golden.anchor);
const NOW = Date.UTC(2026, 10, 2, 17, 0, 0);
const clock = () => new Date(NOW);
const TODAY = localDateOf(new Date(NOW).toISOString(), BR.timezone);
const saved = { ...flags, profitBriefLimits: { ...flags.profitBriefLimits } };

let admin: Db;
let app: Db;
const tenantId = randomUUID();
const session: Session = { sub: `sub-${tenantId}`, email: "", tenantId };
let B: Fixture;
let newest: { start: string; end: string };
let older: { start: string; end: string };
let openWeek: string;

// What the fake model saw.
let seen: AiRequest[] = [];

// The call's row in the model ledger, as complete() writes it before it returns the call's id: a
// brief names the call whose answer was checked, so the id must be a real call of the same carrier.
async function ledgerRow(q: Queryable, id: string, purpose: string, traceId: string | null) {
  await q.execute(
    `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
       reserved_nanocents, cost_nanocents)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
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

// The figure a line of the prompt's list names: "[f1] Revenue: $48,210.00" gives f1 and its text.
function figure(request: AiRequest, label: string): { key: string; text: string } {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const line = user.split("\n").find((l) => l.includes(`] ${label}: `));
  const m = line ? /^\[(f\d+)\] .+?: (.+)$/.exec(line) : null;
  if (!m) throw new Error(`the figures have no ${label}`);
  return { key: m[1], text: m[2] };
}

// Copies two figures exactly, each with its tag, so a good answer passes on its own numbers.
const goodModel: CompleteFn = async (_target, request, s) => {
  const revenue = figure(request, "Revenue");
  const loads = figure(request, "Loads priced");
  return answer(
    request,
    s,
    JSON.stringify({ text: `Revenue was ${revenue.text} [${revenue.key}] on ${loads.text} [${loads.key}] priced loads.` }),
  );
};
// A number that is not the figure it cites.
const wrongModel: CompleteFn = async (_target, request, s) =>
  answer(request, s, JSON.stringify({ text: `Revenue was $1.23 [${figure(request, "Revenue").key}].` }));

const press = (periodStart: string, complete: CompleteFn = goodModel, more: Partial<Parameters<typeof writeBrief>[2]> = {}) =>
  writeBrief(session, { kind: "profit_week", periodStart }, { db: app, complete, clock, log: () => {}, ...more });

type Row = {
  id: string;
  status: string;
  period_start: string;
  body: { text: string } | null;
  refusal_category: string | null;
  verification: { category: string | null } | null;
  model_call_id: string | null;
  trace_id: string | null;
  created_by: string;
  as_of: string;
};

// The clock is fixed, so rows sort by status and reason, not by when they were made.
async function rows(): Promise<Row[]> {
  return admin.withTenant(tenantId, (q) =>
    q.query<Row>(
      `SELECT CAST(id AS text) AS id, status, CAST(period_start AS text) AS period_start, body, refusal_category,
              verification, CAST(model_call_id AS text) AS model_call_id, CAST(trace_id AS text) AS trace_id,
              created_by, CAST(as_of AS text) AS as_of
         FROM briefs WHERE tenant_id = current_tenant_id() ORDER BY created_at, status, refusal_category`,
    ),
  );
}

describe("profit briefs", () => {
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
    B = await makeTenant(admin, `brief-${randomUUID().slice(0, 8)}`);
    const weeks = await app.withTenant(tenantId, (q) => closedWeeks(q, TODAY));
    if (weeks.length < 2) throw new Error("the plan needs two closed weeks");
    newest = weeks[0];
    older = weeks[1];
    const open = PLAN.rows.settlement_periods.find((p) => p.status === "open");
    if (!open) throw new Error("the plan has no open week");
    openWeek = open.period_start;
  });

  beforeEach(async () => {
    Object.assign(flags, saved, {
      profitBriefLimits: { ...saved.profitBriefLimits },
      profitBriefEnabled: true,
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
    Object.assign(flags, saved, { profitBriefLimits: { ...saved.profitBriefLimits } });
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    for (const id of [tenantId, B?.tenantId]) {
      if (!id) continue;
      // Briefs first: each names its model call.
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

  it("reserves the brief, asks once, and drafts it only after every number passes the check", async () => {
    const out = await press(newest.start);
    expect(out).toMatchObject({ ok: true, status: "drafted", category: null });
    expect(seen).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: "drafted",
      period_start: newest.start,
      refusal_category: null,
      verification: { category: null },
      created_by: session.sub,
      as_of: TODAY,
    });
    expect(row.body?.text).toMatch(/^Revenue was \$[\d,]+\.\d{2} \[f1\] on \d+ \[f\d+\] priced loads\.$/);
    // The call it names is this carrier's, under the brief's own trace.
    expect(row.trace_id).toBe(seen[0].traceId);
    const calls = await admin.withTenant(tenantId, (q) =>
      q.query<{ id: string }>("SELECT CAST(id AS text) AS id FROM model_calls WHERE tenant_id = current_tenant_id()"),
    );
    expect(calls.map((c) => c.id)).toEqual([row.model_call_id]);
    // The page reads it back as drafted, its figures unchanged.
    const view = await app.withTenant(tenantId, (q) => readProfitView(q, TODAY, newest.start, flags.profitBriefLimits, clock()));
    expect(view.brief).toMatchObject({ kind: "drafted", changed: false });
  });

  it("writeBrief refuses before any model call when the flag is off, when the period is open, or when a drafted brief exists", async () => {
    flags.profitBriefEnabled = false;
    expect(await press(newest.start)).toEqual({ ok: false, category: "disabled" });
    flags.profitBriefEnabled = true;
    flags.aiEnabled = false;
    expect(await press(newest.start)).toEqual({ ok: false, category: "ai_disabled" });
    flags.aiEnabled = true;
    expect(await press(openWeek)).toEqual({ ok: false, category: "open_period" });
    expect(await press("2020-01-06")).toEqual({ ok: false, category: "not_found" });
    expect(await press("Oct 19")).toEqual({ ok: false, category: "not_found" });
    expect(seen).toHaveLength(0);
    expect(await rows()).toEqual([]);
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    expect(await press(newest.start)).toEqual({ ok: false, category: "exists" });
    expect(seen).toHaveLength(1);
    expect((await rows()).map((r) => r.status)).toEqual(["drafted"]);
  });

  it("a refused brief can be written again and the old row reads superseded", async () => {
    expect(await press(newest.start, wrongModel)).toMatchObject({ ok: true, status: "refused", category: "number_mismatch" });
    const [refused] = await rows();
    expect(refused).toMatchObject({
      status: "refused",
      refusal_category: "number_mismatch",
      body: null,
      verification: { category: "number_mismatch" },
    });
    expect(refused.model_call_id).not.toBeNull();
    const view = await app.withTenant(tenantId, (q) => readProfitView(q, TODAY, newest.start, flags.profitBriefLimits, clock()));
    expect(view.brief).toEqual({ kind: "refused", category: "number_mismatch" });

    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    const after = await rows();
    expect(after.map((r) => [r.id === refused.id, r.status, r.refusal_category, r.body === null])).toEqual([
      [false, "drafted", null, false],
      [true, "superseded", "number_mismatch", true],
    ]);
  });

  it("leaves a call turned down before any request over_cap with its category, a timeout refused, and both can be written again", async () => {
    const turnedDown: CompleteFn = async () => {
      throw new AiError("cap");
    };
    expect(await press(newest.start, turnedDown)).toEqual({ ok: true, briefId: expect.any(String), status: "over_cap", category: "cap" });
    const timedOut: CompleteFn = async () => {
      throw new AiError("timeout");
    };
    expect(await press(newest.start, timedOut)).toMatchObject({ ok: true, status: "refused", category: "timeout" });
    const cutOff: CompleteFn = async (_t, request, s) => answer(request, s, '{"text": "Revenue was', "incomplete");
    expect(await press(newest.start, cutOff)).toMatchObject({ ok: true, status: "refused", category: "incomplete" });
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    expect((await rows()).map((r) => [r.status, r.refusal_category, r.body === null, r.model_call_id === null])).toEqual([
      ["drafted", null, false, false],
      ["superseded", "cap", true, true],
      ["superseded", "incomplete", true, false],
      ["superseded", "timeout", true, true],
    ]);
  });

  it("writes one brief when two presses arrive at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: CompleteFn = async (target, request, s) => {
      await gate;
      return goodModel(target, request, s);
    };
    const first = press(newest.start, slow);
    const second = press(newest.start, slow);
    // Whichever reserved second saw the first's reservation and stopped before its call.
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
      if (ids === 2) flags.profitBriefEnabled = false;
      return randomUUID();
    };
    expect(await press(newest.start, goodModel, { newId })).toMatchObject({ ok: true, status: "over_cap", category: "disabled" });
    expect(seen).toHaveLength(0);
    expect((await rows()).map((r) => [r.status, r.refusal_category, r.model_call_id])).toEqual([["over_cap", "disabled", null]]);
  });

  it("a drafting row older than 10 minutes is marked refused on the next run", async () => {
    const stale = randomUUID();
    const at = new Date(NOW - 11 * 60_000).toISOString();
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO briefs (id, tenant_id, kind, period_start, period_end, as_of, status, figures, model, created_by,
           created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'profit_week', CAST($2 AS date), CAST($3 AS date),
           CAST($4 AS date), 'drafting', CAST('[]' AS jsonb), 'spark', $5, CAST($6 AS timestamptz),
           CAST($6 AS timestamptz))`,
        [stale, older.start, older.end, TODAY, session.sub, at],
      ),
    );
    // The page stops showing it as being written once its lease is out.
    const view = await app.withTenant(tenantId, (q) => readProfitView(q, TODAY, older.start, flags.profitBriefLimits, clock()));
    expect(view.brief).toEqual({ kind: "refused", category: "interrupted" });
    // A press for another week marks it; it is never shown as checked.
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    const marked = (await rows()).find((r) => r.id === stale);
    expect(marked).toMatchObject({ status: "refused", refusal_category: "interrupted", body: null });
    // Its own week can be written again.
    expect(await press(older.start)).toMatchObject({ ok: true, status: "drafted" });
    expect((await rows()).find((r) => r.id === stale)?.status).toBe("superseded");
  });

  it("answers refused, never drafted, when a later press marked its row interrupted during the call", async () => {
    const later = () => new Date(NOW + BRIEF_LEASE_MS + 60_000);
    const slow: CompleteFn = async (target, request, s) => {
      // The call runs past its lease: a press for another week marks this row interrupted first.
      expect(await press(older.start, goodModel, { clock: later })).toMatchObject({ ok: true, status: "drafted" });
      return goodModel(target, request, s);
    };
    expect(await press(newest.start, slow)).toEqual({
      ok: true,
      briefId: expect.any(String),
      status: "refused",
      category: "interrupted",
    });
    expect(seen).toHaveLength(2);
    const mine = (await rows()).filter((r) => r.period_start === newest.start);
    expect(mine.map((r) => [r.status, r.refusal_category, r.body, r.model_call_id])).toEqual([
      ["refused", "interrupted", null, null],
    ]);
    // The page shows the row as it is, and the week can be written again.
    const view = await app.withTenant(tenantId, (q) => readProfitView(q, TODAY, newest.start, flags.profitBriefLimits, clock()));
    expect(view.brief).toEqual({ kind: "refused", category: "interrupted" });
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
  });

  it("another carrier cannot read the brief", async () => {
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    const [mine] = await rows();
    const seenByB = await app.withTenant(B.tenantId, async (q) => ({
      table: await readTable(q, "briefs"),
      week: await readProfitBriefs(q, newest.start),
      counted: await q.query<{ n: number }>("SELECT count(*)::int AS n FROM briefs"),
      changed: await q.execute(
        "UPDATE briefs SET status = 'superseded' WHERE id = CAST($1 AS uuid)",
        [mine.id],
      ),
    }));
    expect(seenByB).toEqual({ table: [], week: [], counted: [{ n: 0 }], changed: 0 });
    // B's member cannot write into A's carrier either.
    await expect(
      writeBrief({ ...B.session, tenantId }, { kind: "profit_week", periodStart: newest.start }, { db: app, complete: goodModel, clock }),
    ).rejects.toThrow();
    expect((await rows()).map((r) => r.status)).toEqual(["drafted"]);
  });

  it("keeps a brief's words final and its figures fixed in the database", async () => {
    expect(await press(newest.start)).toMatchObject({ ok: true, status: "drafted" });
    const [row] = await rows();
    const asApp = (sql: string, params: unknown[] = []) =>
      sqlStateOf(app.withTenant(tenantId, (q) => q.execute(sql, params as never[])));
    expect(await asApp(`UPDATE briefs SET body = CAST('{"text":"x"}' AS jsonb) WHERE id = CAST($1 AS uuid)`, [row.id])).toBe("23514");
    expect(await asApp("UPDATE briefs SET status = 'superseded' WHERE id = CAST($1 AS uuid)", [row.id])).toBe("23514");
    // The figures, the period and who asked are not the app's to change at all.
    expect(await asApp("UPDATE briefs SET figures = CAST('[]' AS jsonb) WHERE id = CAST($1 AS uuid)", [row.id])).toBe("42501");
    // A new row is only ever a bare reservation.
    expect(
      await asApp(
        `INSERT INTO briefs (tenant_id, kind, period_start, period_end, as_of, status, figures, body, created_by)
         VALUES (current_tenant_id(), 'profit_week', CAST($1 AS date), CAST($2 AS date), CAST($2 AS date), 'drafted',
           CAST('[]' AS jsonb), CAST('{"text":"x"}' AS jsonb), 'x')`,
        [older.start, older.end],
      ),
    ).toBe("23514");
    // A brief names only its own carrier's model call.
    const otherCall = randomUUID();
    await admin.withTenant(B.tenantId, (q) => ledgerRow(q, otherCall, "profit_brief", null));
    const fresh = randomUUID();
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO briefs (id, tenant_id, kind, period_start, period_end, as_of, status, figures, created_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'profit_week', CAST($2 AS date), CAST($3 AS date),
           CAST($3 AS date), 'drafting', CAST('[]' AS jsonb), 'x')`,
        [fresh, older.start, older.end],
      ),
    );
    expect(
      await asApp(
        `UPDATE briefs SET status = 'refused', refusal_category = 'error', model_call_id = CAST($2 AS uuid)
          WHERE id = CAST($1 AS uuid)`,
        [fresh, otherCall],
      ),
    ).toBe("23503");
    // One live brief a week.
    expect(
      await asApp(
        `INSERT INTO briefs (tenant_id, kind, period_start, period_end, as_of, status, figures, created_by)
         VALUES (current_tenant_id(), 'profit_week', CAST($1 AS date), CAST($2 AS date), CAST($2 AS date),
           'drafting', CAST('[]' AS jsonb), 'x')`,
        [newest.start, newest.end],
      ),
    ).toBe("23505");
  });
});
