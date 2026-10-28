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
import { localDateOf, quarterContaining } from "../time/local-date";
import { readQuarterReviews, readQuarterView } from "./quarter-review";
import { writeQuarterReview, type QuarterCompleteFn, type WriteQuarterDeps } from "./write-quarter";

// The quarter review against the real database, as the app's role, on the seeded Blue Ridge
// carrier, with a fake model. A review is
// reserved before its one Wonder call and drafted only when every number in every list passes the
// check; a press while one is out, or after one passed, writes nothing; a failed review keeps no
// words and can be written again, the old row superseded; a timeout is refused, never stored as a
// review, and the figures page keeps working; the switch is checked again right before the call;
// the database keeps the lists final; and another carrier sees none of it. Only this file's two
// tenants are made, and they are removed after.

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
});
