import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "../agent/gateway/__tests__/plan-db";
import { TENANT, type FakeDb } from "../agent/gateway/__tests__/fake-db";
import { getQuarterReview } from "../agent/gateway/tools/read/get-quarter-review";
import type { GatewayContext } from "../agent/gateway/types";
import { AiError, complete, type AiRequest, type AiResult } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { FetchFn } from "../ai/providers/http";
import { QUIET_JOB } from "../ai/test-fixtures";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { parseReportArgs } from "../reports/args";
import { computeReport } from "../reports/run";
import type { BriefFigure } from "../rules-engine";
import { quarterContaining } from "../time/local-date";
import { figuresText, figureValueText } from "./figures";
import { packFigures, readQuarter } from "./quarter-figures";
import {
  QUARTER_SECTIONS,
  quarterBodyOf,
  quarterStateOf,
  readQuarterView,
  SECTION_ITEMS,
  verifyQuarter,
  type QuarterRecord,
} from "./quarter-review";
import {
  REVIEW_CHECK_FAILED,
  REVIEW_DID_NOT_FINISH,
  REVIEW_UNREADABLE,
  reviewOutcome,
  reviewRefusalWords,
  SECTION_TITLES,
} from "./quarter-words";
import { BRIEF_LEASE_MS, figuresOf } from "./view";
import {
  QUARTER_FORMAT,
  QUARTER_ITEM_CHARS,
  QUARTER_PURPOSE,
  QUARTER_TIMEOUT_MS,
  quarterRequest,
  writeQuarterReview,
  type QuarterCompleteFn,
} from "./write-quarter";

// The quarter review's parts on the Blue Ridge seed plan with no database: the engine's quarter
// so far through the real readers, the pack the model is given, the number check every item
// passes, the model request, the page's state and words, the writer's steps (with the briefs
// table played by a small fake), the one call through the real wrapper in Contributor mode, and
// the agent's read tool. No model is ever reached: every reply here is written by the test.

const plan = blueRidgePlan();
const NOW = new Date(Date.UTC(2026, 10, 2, 17, 0, 0));
const TZ = plan.carrier.timezone;
const PERIOD = quarterContaining(PLAN_ANCHOR);
const SESSION: Session = { sub: "sub-quarter", email: "desk@example.test", tenantId: TENANT };

const saved = {
  review: flags.quarterReviewEnabled,
  ai: flags.aiEnabled,
  limits: flags.quarterReviewLimits,
};

afterEach(() => {
  flags.quarterReviewEnabled = saved.review;
  flags.aiEnabled = saved.ai;
  flags.quarterReviewLimits = saved.limits;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const seeded = () => planDb(plan).withTenant(TENANT, (q) => readQuarter(q, PERIOD, PLAN_ANCHOR, TZ));

function quote(figures: readonly BriefFigure[], label: string): string {
  const f = figures.find((x) => x.label === label);
  if (!f) throw new Error(`no figure ${label}`);
  return `${figureValueText(f)} [${f.key}]`;
}

// A reply whose every number is its tagged figure.
function replyFrom(figures: readonly BriefFigure[], over: Partial<Record<string, unknown>> = {}): string {
  const q = (label: string) => quote(figures, label);
  return JSON.stringify({
    went_well: [`Margin on priced loads was ${q("Margin on priced loads")}, or ${q("Margin as a share of revenue")} of revenue.`],
    problems: [`Paystubs with a problem so far: ${q("Paystubs with a problem")}.`],
    recovered: [`Advances recovered from pay came to ${q("Advances recovered from pay")}.`],
    change: [
      `Collect the open receivables past due, ${q("Open receivables past due")}.`,
      `Bill the detention not billed so far, ${q("Detention not billed")}.`,
      `Look into the paystub problems found, ${q("Paystub problems found")}.`,
    ],
    ...over,
  });
}

describe("the seeded quarter so far", () => {
  it("counts 3 paid pay runs and 1 open one on the seeded Blue Ridge quarter, summing only the closed ones", async () => {
    const q = await seeded();
    expect(PERIOD).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    // From the plan's own rows: the runs whose last day falls in the quarter and that began by today.
    const runs = plan.rows.settlement_periods.filter(
      (p) => p.period_end >= PERIOD.start && p.period_end <= PERIOD.end && p.period_start <= PLAN_ANCHOR,
    );
    const closed = new Set(runs.filter((p) => p.status === "paid" || p.status === "approved").map((p) => p.id));
    const stubs = plan.rows.settlements.filter((s) => closed.has(s.period_id));
    const ids = new Set(stubs.map((s) => s.id));
    const recovery = plan.rows.settlement_lines.filter((l) => l.kind === "advance_recovery" && ids.has(l.settlement_id));
    expect(runs.filter((p) => p.status === "paid")).toHaveLength(3);
    expect(runs.filter((p) => p.status === "open")).toHaveLength(1);
    expect(q.pay).toMatchObject({ runs: 4, paid: 3, approved: 0, open: 1, paystubs: stubs.length });
    expect(q.pay.netCents).toBe(stubs.reduce((n, s) => n + Number(s.net_cents), 0));
    expect(q.pay.grossCents).toBe(stubs.reduce((n, s) => n + Number(s.gross_cents), 0));
    expect(q.recovered.advancesCents).toBe(-recovery.reduce((n, l) => n + Number(l.amount_cents), 0));
    expect(q.recovered.advancesCents).toBeGreaterThan(0);
    // The seed holds no agent fixes: nothing recovered by them, nothing suggested.
    expect(q.exceptions.suggested).toBe(0);
    expect(q.recovered.detentionCount + q.recovered.correctionsCount).toBe(0);
  });

  it("prices the quarter's loads to the cent as the margin report does for the same days", async () => {
    const q = await seeded();
    const args = parseReportArgs("margin_per_load", { periodStart: PERIOD.start, periodEnd: PLAN_ANCHOR });
    if (!args) throw new Error("bad margin args");
    const report = await planDb(plan).withTenant(TENANT, (x) => computeReport(x, args, { now: NOW, timeZone: TZ }));
    const sums = report.totals ?? report.subtotals?.[0]?.totals;
    expect(q.margin.loads).toBeGreaterThan(0);
    expect(sums?.revenueCents).toBe(q.margin.revenueCents);
    expect(sums?.driverPayCents).toBe(q.margin.driverPayCents);
    expect(sums?.marginCents).toBe(q.margin.marginCents);
    expect(sums?.marginBps ?? null).toBe(q.margin.marginBps);
  });

  it("numbers the figures in order with no digit in a label, and the stored shape reads back whole", async () => {
    const { figures } = await seeded();
    expect(figures.map((f) => f.key)).toEqual(figures.map((_, i) => `f${i + 1}`));
    for (const f of figures) expect(f.label, f.key).not.toMatch(/\d/);
    expect(figuresOf(JSON.parse(JSON.stringify(figures)) as unknown[])).toEqual(figures);
  });

  it("the pack is cut at maxInputChars and the headline figures survive the cut", async () => {
    const { figures } = await seeded();
    expect(packFigures(figures, flags.quarterReviewLimits.maxInputChars)).toEqual(figures);
    const ten = figuresText(figures.slice(0, 10)).length;
    expect(packFigures(figures, ten)).toEqual(figures.slice(0, 10));
    expect(packFigures(figures, ten - 1)).toEqual(figures.slice(0, 9));
    const cut = packFigures(figures, 600);
    expect(cut.length).toBeGreaterThan(3);
    expect(cut.length).toBeLessThan(figures.length);
    expect(figuresText(cut).length).toBeLessThanOrEqual(600);
    expect(cut[0].label).toBe("Pay runs so far");
    expect(cut).toEqual(figures.slice(0, cut.length));
    expect(packFigures(figures, 0)).toEqual([]);
  });
});

describe("the review's number check", () => {
  it("passes a review whose every number is its tagged figure, keeping the tags", async () => {
    const { figures } = await seeded();
    const checked = verifyQuarter(replyFrom(figures), figures);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(QUARTER_SECTIONS.every((s) => checked.body[s].every((item) => /\[f\d+\]/.test(item)))).toBe(true);
    expect(checked.verification.category).toBeNull();
    expect(checked.verification.numbers).toBe(7);
    const cited = checked.verification.cited.map((k) => Number(k.slice(1)));
    expect(cited).toEqual([...cited].sort((a, b) => a - b));
  });

  it("a review item with an untagged number refuses the whole review, keeping no words", async () => {
    const { figures } = await seeded();
    const item = `Paystubs with a problem so far: ${quote(figures, "Paystubs with a problem")}, across 3 pay runs.`;
    const checked = verifyQuarter(replyFrom(figures, { problems: [item] }), figures);
    expect(checked).toMatchObject({ ok: false, category: "untagged" });
    expect("body" in checked).toBe(false);
    // An item that cites no figure at all is not the shape asked for.
    expect(verifyQuarter(replyFrom(figures, { problems: ["Paystub problems keep coming back."] }), figures)).toMatchObject({
      ok: false,
      category: "format",
    });
  });

  it("refuses a number word, a wrong value, a tag that does not exist, and a gain written with a minus", async () => {
    const { figures } = await seeded();
    const q = (label: string) => quote(figures, label);
    const margin = figures.find((f) => f.label === "Margin on priced loads");
    if (!margin) throw new Error("no margin figure");
    for (const [item, category] of [
      [`Margin held up this quarter at ${q("Margin on priced loads")}.`, "untagged"],
      [`Margin was $1.00 [${margin.key}].`, "number_mismatch"],
      [`Margin was ${figureValueText(margin)} [f999].`, "unknown_tag"],
      [`Margin was -${q("Margin on priced loads")}.`, "number_mismatch"],
      [`Margin was a loss of ${q("Margin on priced loads")}.`, "number_mismatch"],
    ] as const) {
      expect(verifyQuarter(replyFrom(figures, { went_well: [item] }), figures), item).toMatchObject({ ok: false, category });
    }
  });

  it("refuses a reply that is not exactly the four lists, each the length asked", async () => {
    const { figures } = await seeded();
    const good = JSON.parse(replyFrom(figures)) as Record<string, string[]>;
    for (const bad of [
      "not json",
      JSON.stringify({ ...good, change: good.change.slice(0, 2) }),
      JSON.stringify({ ...good, went_well: [] }),
      JSON.stringify({ ...good, extra: ["x"] }),
      JSON.stringify({ went_well: good.went_well, problems: good.problems, recovered: good.recovered }),
      JSON.stringify({ ...good, problems: [1] }),
      JSON.stringify([good]),
      JSON.stringify({ ...good, recovered: Array.from({ length: SECTION_ITEMS.recovered.max + 1 }, () => good.recovered[0]) }),
    ]) {
      expect(verifyQuarter(bad, figures), bad.slice(0, 40)).toMatchObject({ ok: false, category: "format" });
    }
    expect(quarterBodyOf(null)).toBeNull();
    expect(quarterBodyOf(good)).toEqual(good);
  });
});

describe("the review's model request", () => {
  it("asks once, capped, for the four lists as strict JSON, from the figures and nothing else", async () => {
    const { figures } = await seeded();
    const r = quarterRequest(figures, "trace-q");
    expect(r).toMatchObject({
      purpose: QUARTER_PURPOSE,
      reasoningEffort: "medium",
      maxOutputTokens: 1_600,
      maxCostCents: 30,
      timeoutMs: QUARTER_TIMEOUT_MS,
      traceId: "trace-q",
      format: QUARTER_FORMAT,
    });
    expect(r.maxOutputTokens).toBe(flags.quarterReviewLimits.maxOutputTokens);
    expect(r.maxCostCents).toBe(flags.quarterReviewLimits.maxReviewCents);
    expect(QUARTER_FORMAT).toMatchObject({ name: "quarter_review", strict: true });
    const schema = QUARTER_FORMAT.schema as { required: string[]; additionalProperties: boolean; properties: Record<string, object> };
    expect(schema.required).toEqual([...QUARTER_SECTIONS]);
    expect(schema.additionalProperties).toBe(false);
    // Only the verified strict subset: no item counts in the schema, which a provider could turn
    // down for every press. The check holds the counts instead.
    for (const s of QUARTER_SECTIONS) {
      expect(schema.properties[s], s).toEqual({ type: "array", items: { type: "string" } });
    }
    expect(JSON.stringify(QUARTER_FORMAT.schema)).not.toMatch(/minItems|maxItems/);
    const good = JSON.parse(replyFrom(figures)) as Record<string, string[]>;
    expect(quarterBodyOf({ ...good, change: [...good.change, good.change[0]] })).toBeNull();
    expect(quarterBodyOf({ ...good, change: good.change.slice(0, 2) })).toBeNull();
    expect(quarterBodyOf({ ...good, went_well: [] })).toBeNull();
    expect(r.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const user = r.messages[1].content;
    expect(user).toContain(figuresText(figures));
    expect(user).toContain(`at most ${QUARTER_ITEM_CHARS} characters`);
    // Figures only: no date, record id, email or driver's last name.
    expect(user).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(user).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(user).not.toContain("@");
    const named = plan.rows.drivers.filter((d) => figures.some((f) => "table" in f.source && f.source.id === d.id));
    expect(named.length).toBeGreaterThan(0);
    for (const d of named) {
      expect(user, d.id).not.toContain(d.last_name);
      expect(user, d.id).toContain(`Driver ${d.first_name} ${d.last_name[0]}. (`);
    }
  });

  it("names a driver by first name and last initial, and an item that uses that name passes the check", async () => {
    const { figures } = await seeded();
    const driver = figures.find((f) => "table" in f.source && f.source.table === "drivers" && f.kind === "cents");
    if (!driver?.subject) throw new Error("no driver figure");
    expect(driver.subject).toMatch(/^\S+ \S\.$/);
    expect(driver.label).toBe(`Driver ${driver.subject} (most net pay): net pay`);
    const item = `${driver.subject} had the most net pay, ${figureValueText(driver)} [${driver.key}].`;
    const checked = verifyQuarter(replyFrom(figures, { went_well: [item] }), figures);
    expect(checked).toMatchObject({ ok: true });
  });
});

describe("the review's state", () => {
  const FIGS: BriefFigure[] = [{ key: "f1", label: "Pay runs so far", kind: "int", value: 4, source: { section: "pay_runs" } }];
  const body = { went_well: ["a"], problems: ["b"], recovered: ["c"], change: ["d", "e", "f"] };
  const record = (over: Partial<QuarterRecord>): QuarterRecord => ({
    id: "r1",
    status: "drafted",
    quarterStart: PERIOD.start,
    quarterEnd: PERIOD.end,
    asOf: PLAN_ANCHOR,
    figures: FIGS,
    body,
    category: null,
    updatedAt: "2026-11-02T16:55:00.000Z",
    ...over,
  });

  it("reads none, writing, refused and drafted, and marks a review whose figures moved", () => {
    expect(quarterStateOf([], FIGS, NOW)).toEqual({ kind: "none" });
    expect(quarterStateOf([record({ status: "superseded", body: null })], FIGS, NOW)).toEqual({ kind: "none" });
    expect(quarterStateOf([record({ status: "drafting", body: null })], FIGS, NOW)).toEqual({ kind: "writing" });
    const old = new Date(NOW.getTime() - BRIEF_LEASE_MS - 1).toISOString();
    expect(quarterStateOf([record({ status: "drafting", body: null, updatedAt: old })], FIGS, NOW)).toEqual({
      kind: "refused",
      category: "interrupted",
    });
    expect(quarterStateOf([record({ status: "refused", body: null, category: "timeout" })], FIGS, NOW)).toEqual({
      kind: "refused",
      category: "timeout",
    });
    expect(quarterStateOf([record({ status: "over_cap", body: null, category: null })], FIGS, NOW)).toEqual({
      kind: "refused",
      category: "error",
    });
    const drafted = record({});
    expect(quarterStateOf([drafted], FIGS, NOW)).toEqual({ kind: "drafted", review: drafted, changed: false });
    expect(quarterStateOf([drafted], [{ ...FIGS[0], value: 5 }], NOW)).toMatchObject({ kind: "drafted", changed: true });
    // A drafted review is final: a later failed row never hides it.
    expect(quarterStateOf([record({ id: "r2", status: "refused", body: null, category: "cap" }), drafted], FIGS, NOW)).toMatchObject({
      kind: "drafted",
    });
  });

  it("reads a drafted review whose lists do not read back as unreadable, never as a try to write again", () => {
    expect(quarterStateOf([record({ body: null })], FIGS, NOW)).toEqual({ kind: "unreadable" });
    expect(quarterStateOf([record({ body: null, figures: [] })], FIGS, NOW)).toEqual({ kind: "unreadable" });
    // An older failed try under it does not turn it back into "write again".
    expect(
      quarterStateOf([record({ body: null }), record({ id: "r0", status: "refused", body: null, category: "timeout" })], FIGS, NOW),
    ).toEqual({ kind: "unreadable" });
  });
});

describe("the review's words", () => {
  it("says the check failed for every check category, and did not finish for a timeout or a cut-off reply", () => {
    for (const c of ["format", "unknown_tag", "number_mismatch", "untagged"]) expect(reviewRefusalWords(c)).toBe(REVIEW_CHECK_FAILED);
    for (const c of ["timeout", "unavailable", "incomplete", "interrupted", "error", "unknown"]) {
      expect(reviewRefusalWords(c)).toBe(REVIEW_DID_NOT_FINISH);
    }
    expect(reviewRefusalWords("cap")).toMatch(/budget is used up/);
    expect(reviewRefusalWords("disabled")).toMatch(/agent is off/);
  });

  it("turns each reply into one fixed sentence, never the server's words", () => {
    expect(reviewOutcome({ ok: true, error: null, data: { status: "drafted" } })).toMatch(/every number checked/);
    expect(reviewOutcome({ ok: true, error: null, data: { status: "refused", category: "untagged" } })).toBe(REVIEW_CHECK_FAILED);
    expect(reviewOutcome({ ok: true, error: null, data: { status: "over_cap", category: "job_cap" } })).toMatch(/hourly budget/);
    expect(reviewOutcome({ ok: true, error: null, data: {} })).toMatch(/not known yet/);
    expect(reviewOutcome({ ok: false, error: "exists", data: {} })).toMatch(/already written/);
    expect(reviewOutcome({ ok: false, error: "no_activity", data: {} })).toMatch(/nothing to review/);
    expect(reviewOutcome({ ok: false, error: "unknown", data: {} })).toMatch(/not known yet/);
    expect(reviewOutcome({ ok: false, error: "Internal Server Error: stack", data: {} })).toBe(REVIEW_DID_NOT_FINISH);
  });

  it("uses the house words only", () => {
    const all = [
      REVIEW_CHECK_FAILED,
      REVIEW_DID_NOT_FINISH,
      REVIEW_UNREADABLE,
      ...Object.values(SECTION_TITLES),
      ...["cap", "too_expensive", "job_cap", "disabled", "timeout"].map(reviewRefusalWords),
      ...["exists", "in_progress", "no_activity", "review_off", "ai_off", "forbidden", "unknown"].map((error) =>
        reviewOutcome({ ok: false, error, data: {} }),
      ),
    ].join(" ");
    expect(all).not.toMatch(/proposal|tenant|rules engine|verdict|\blane|token|\u2014/i);
  });
});

// ---- The writer, with the briefs table played by a small fake over the seed plan ----

type BriefFake = Record<string, unknown> & { id: string; status: string; updated_at: string };

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

function writerDb(): { db: FakeDb; briefs: BriefFake[] } {
  const briefs: BriefFake[] = [];
  const db = planDb(plan, (raw, params) => {
    const sql = flat(raw);
    if (sql.startsWith("SELECT count(*) AS n FROM ( SELECT pg_advisory_xact_lock")) return [{ n: 1 }];
    if (sql.startsWith("UPDATE briefs SET status = 'refused', refusal_category = 'interrupted'")) {
      const stale = briefs.filter((b) => b.status === "drafting" && b.updated_at < String(params[1]));
      for (const b of stale) {
        b.status = "refused";
        b.refusal_category = "interrupted";
        b.updated_at = String(params[0]);
      }
      return stale.length;
    }
    if (sql.startsWith("SELECT CAST(id AS text) AS id, status FROM briefs")) {
      return briefs
        .filter((b) => b.kind === "quarter" && b.period_start === params[0] && ["drafting", "drafted"].includes(b.status))
        .map((b) => ({ id: b.id, status: b.status }));
    }
    if (sql.startsWith("UPDATE briefs SET status = 'superseded'")) {
      const failed = briefs.filter((b) => b.kind === "quarter" && b.period_start === params[0] && ["refused", "over_cap"].includes(b.status));
      for (const b of failed) Object.assign(b, { status: "superseded", updated_at: params[1] });
      return failed.length;
    }
    if (sql.startsWith("INSERT INTO briefs")) {
      const live = briefs.some((b) => b.kind === "quarter" && b.period_start === params[1] && ["drafting", "drafted"].includes(b.status));
      if (live) return 0;
      briefs.push({
        id: String(params[0]),
        kind: "quarter",
        period_start: params[1],
        period_end: params[2],
        as_of: params[3],
        status: "drafting",
        figures: JSON.parse(String(params[4])),
        body: null,
        refusal_category: null,
        verification: null,
        model: "wonder",
        trace_id: params[5],
        model_call_id: null,
        created_by: params[6],
        updated_at: String(params[7]),
      });
      return 1;
    }
    if (sql.startsWith("UPDATE briefs SET status = $2, body = CAST($3 AS jsonb)")) {
      const row = briefs.find((b) => b.id === params[0] && b.kind === "quarter" && b.status === "drafting");
      if (!row) return 0;
      row.status = String(params[1]);
      row.body = params[2] === null ? null : JSON.parse(String(params[2]));
      row.verification = params[3] === null ? null : JSON.parse(String(params[3]));
      row.refusal_category = params[4];
      row.model_call_id = params[5];
      row.updated_at = String(params[6]);
      return 1;
    }
    return undefined;
  });
  db.tables.briefs = briefs;
  return { db, briefs };
}

function answer(text: string, status: AiResult["status"] = "ok"): AiResult {
  return {
    callId: "c0ffee00-0000-4000-8000-000000000001",
    status,
    text,
    toolCalls: [],
    usage: { input: 2_000, cached: 0, output: 600, reasoning: 300 },
    costNanocents: 0,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

let ids = 0;
const newId = () => `0a0a0a0a-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function writer(db: FakeDb, call: QuarterCompleteFn, clock: () => Date = () => NOW) {
  return writeQuarterReview(SESSION, { db, complete: call, clock, newId, log: () => {} });
}

describe("writing the review", () => {
  beforeEach(() => {
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = true;
  });

  it("reserves, asks Wonder once, checks every item and stores the lists; a second press finds it written", async () => {
    const { db, briefs } = writerDb();
    const { figures } = await seeded();
    const call = vi.fn<QuarterCompleteFn>(async () => answer(replyFrom(figures)));
    const out = await writer(db, call);
    expect(out).toMatchObject({ ok: true, status: "drafted", category: null });
    expect(call).toHaveBeenCalledTimes(1);
    const [target, request, session] = call.mock.calls[0];
    expect(target).toBe("wonder");
    expect((request as AiRequest).purpose).toBe(QUARTER_PURPOSE);
    expect(session).toBe(SESSION);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      kind: "quarter",
      period_start: "2026-10-01",
      period_end: "2026-12-31",
      as_of: PLAN_ANCHOR,
      status: "drafted",
      model: "wonder",
      refusal_category: null,
      model_call_id: "c0ffee00-0000-4000-8000-000000000001",
    });
    expect(briefs[0].figures).toEqual(figures);
    expect(quarterBodyOf(briefs[0].body)).not.toBeNull();
    expect(await writer(db, call)).toEqual({ ok: false, category: "exists" });
    expect(call).toHaveBeenCalledTimes(1);
    // The page reads the review back with its figures unchanged.
    const view = await db.withTenant(TENANT, (q) => readQuarterView(q, PLAN_ANCHOR, TZ, 40_000, NOW));
    expect(view.review).toMatchObject({ kind: "drafted", changed: false });
  });

  it("a written review whose stored lists or figures no longer read back is unreadable, and a press still finds it written", async () => {
    const { db, briefs } = writerDb();
    const { figures } = await seeded();
    const call = vi.fn<QuarterCompleteFn>(async () => answer(replyFrom(figures)));
    expect(await writer(db, call)).toMatchObject({ ok: true, status: "drafted" });
    const read = () => db.withTenant(TENANT, (q) => readQuarterView(q, PLAN_ANCHOR, TZ, 40_000, NOW));
    const body = briefs[0].body as Record<string, string[]>;
    briefs[0].body = { ...body, change: body.change.slice(0, 2) };
    expect((await read()).review).toEqual({ kind: "unreadable" });
    briefs[0].body = body;
    briefs[0].figures = [{ key: "f1", label: "Pay runs so far", kind: "words", value: 3 }];
    expect((await read()).review).toEqual({ kind: "unreadable" });
    expect(await writer(db, call)).toEqual({ ok: false, category: "exists" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("an item with an untagged number refuses the review and keeps no words; the next press writes again", async () => {
    const { db, briefs } = writerDb();
    const { figures } = await seeded();
    const recovered = `Advances recovered from pay came to ${quote(figures, "Advances recovered from pay")}, out of $2,000.00 taken.`;
    const bad = vi.fn<QuarterCompleteFn>(async () => answer(replyFrom(figures, { recovered: [recovered] })));
    expect(await writer(db, bad)).toMatchObject({ ok: true, status: "refused", category: "untagged" });
    expect(briefs[0]).toMatchObject({ status: "refused", body: null, refusal_category: "untagged" });
    expect(briefs[0].verification).toMatchObject({ category: "untagged" });
    const good = vi.fn<QuarterCompleteFn>(async () => answer(replyFrom(figures)));
    expect(await writer(db, good)).toMatchObject({ ok: true, status: "drafted" });
    expect(briefs.map((b) => b.status)).toEqual(["superseded", "drafted"]);
  });

  it("a Wonder timeout stores refused with category timeout and leaves the figures page working", async () => {
    const { db, briefs } = writerDb();
    const timeout = vi.fn<QuarterCompleteFn>(async () => {
      throw new AiError("timeout");
    });
    expect(await writer(db, timeout)).toMatchObject({ ok: true, status: "refused", category: "timeout" });
    expect(briefs[0]).toMatchObject({ status: "refused", body: null, refusal_category: "timeout", model_call_id: null });
    const view = await db.withTenant(TENANT, (q) => readQuarterView(q, PLAN_ANCHOR, TZ, 40_000, NOW));
    expect(view.quarter.pay.runs).toBe(4);
    expect(view.review).toEqual({ kind: "refused", category: "timeout" });
    expect(reviewRefusalWords("timeout")).toBe(REVIEW_DID_NOT_FINISH);
  });

  it("a server error or a reply cut off is refused, never stored as a review", async () => {
    for (const [call, category] of [
      [async () => Promise.reject(new AiError("unavailable", 503)), "unavailable"],
      [async () => answer('{"went_well": ["Margin', "incomplete"), "incomplete"],
    ] as const) {
      const { db, briefs } = writerDb();
      expect(await writer(db, call), category).toMatchObject({ ok: true, status: "refused", category });
      expect(briefs[0]).toMatchObject({ status: "refused", body: null });
    }
  });

  it("a call the wrapper turns down before any request is over_cap, and the review can be asked again", async () => {
    for (const category of ["cap", "job_cap", "too_expensive", "disabled", "not_configured"] as const) {
      const { db, briefs } = writerDb();
      const call = vi.fn<QuarterCompleteFn>(async () => {
        throw new AiError(category);
      });
      expect(await writer(db, call), category).toMatchObject({ ok: true, status: "over_cap", category });
      expect(briefs[0]).toMatchObject({ status: "over_cap", body: null, refusal_category: category });
    }
  });

  it("an unexpected failure leaves the row refused and is raised", async () => {
    const { db, briefs } = writerDb();
    await expect(writer(db, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(briefs[0]).toMatchObject({ status: "refused", refusal_category: "error", body: null });
  });

  it("checks both switches first, and the review switch again right before the call", async () => {
    const { db, briefs } = writerDb();
    const call = vi.fn<QuarterCompleteFn>(async () => answer("{}"));
    flags.quarterReviewEnabled = false;
    expect(await writer(db, call)).toEqual({ ok: false, category: "disabled" });
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = false;
    expect(await writer(db, call)).toEqual({ ok: false, category: "ai_disabled" });
    expect(briefs).toHaveLength(0);
    flags.aiEnabled = true;
    // Switched off while the figures were read: the reservation closes and nothing is asked.
    let n = 0;
    const off = () => {
      n += 1;
      if (n === 2) flags.quarterReviewEnabled = false;
      return newId();
    };
    const out = await writeQuarterReview(SESSION, { db, complete: call, clock: () => NOW, newId: off, log: () => {} });
    expect(out).toMatchObject({ ok: true, status: "over_cap", category: "disabled" });
    expect(call).not.toHaveBeenCalled();
    expect(briefs[0]).toMatchObject({ status: "over_cap", body: null });
  });

  it("waits on a review being written, and takes over one cut off past its lease", async () => {
    const { db, briefs } = writerDb();
    const { figures } = await seeded();
    const hang = vi.fn<QuarterCompleteFn>(async () => answer(replyFrom(figures)));
    briefs.push({
      id: "0b0b0b0b-0000-4000-8000-000000000001",
      kind: "quarter",
      period_start: PERIOD.start,
      period_end: PERIOD.end,
      as_of: PLAN_ANCHOR,
      status: "drafting",
      figures,
      body: null,
      refusal_category: null,
      verification: null,
      model: "wonder",
      trace_id: null,
      model_call_id: null,
      created_by: SESSION.sub,
      updated_at: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(await writer(db, hang)).toEqual({ ok: false, category: "in_progress" });
    expect(hang).not.toHaveBeenCalled();
    const later = () => new Date(NOW.getTime() + BRIEF_LEASE_MS);
    expect(await writer(db, hang, later)).toMatchObject({ ok: true, status: "drafted" });
    expect(briefs.map((b) => [b.status, b.refusal_category])).toEqual([
      ["superseded", "interrupted"],
      ["drafted", null],
    ]);
  });

  it("asks nothing when nothing happened yet, or when no figure fits the prompt", async () => {
    const call = vi.fn<QuarterCompleteFn>(async () => answer("{}"));
    const quiet = writerDb();
    for (const table of ["settlement_periods", "settlements", "loads", "invoices", "customer_payments", "payment_applications"]) {
      quiet.db.tables[table] = [];
    }
    expect(await writer(quiet.db, call)).toEqual({ ok: false, category: "no_activity" });
    const tight = writerDb();
    flags.quarterReviewLimits = { ...saved.limits, maxInputChars: 0 };
    expect(await writer(tight.db, call)).toEqual({ ok: false, category: "no_activity" });
    expect(call).not.toHaveBeenCalled();
    expect([...quiet.briefs, ...tight.briefs]).toHaveLength(0);
  });
});

// ---- Contributor mode: the one call, through the real wrapper ----

const ENV: Record<string, string> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  AI_SPEND_CAP_CENTS: "12000",
  AI_WONDER_CAP_CENTS: "3000",
  META_CONTRIBUTOR_MODE: "true",
  META_API_KEY: "test-key-abcdefghijklmnop",
};

// The model-call ledger, answered just well enough for one call to reserve and settle.
function ledger(seen: { reserved: number }): TenantDb {
  let reserved = 0;
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM spend_alerts")) return [QUIET_JOB] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          { spent_nanocents: 0, reserved_nanocents: 0, calls: 0, wonder_spent_nanocents: 0, wonder_reserved_nanocents: 0 },
        ] as T[];
      }
      if (sql.includes("FROM model_calls")) return [{ reserved_nanocents: reserved, target: "wonder" }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        reserved = Number(params[8]);
        seen.reserved = reserved;
      }
      return 1;
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

describe("the review in Contributor mode", () => {
  beforeEach(() => {
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = true;
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("the review never runs on contributor mode: it still asks muse-wonder-1.0, once, inside its caps", async () => {
    const { db, briefs } = writerDb();
    const { figures } = await seeded();
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json({
        id: "resp_quarter1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: replyFrom(figures) }] }],
        usage: { input_tokens: 2_400, output_tokens: 900 },
      }),
    );
    const seen = { reserved: 0 };
    const spend = ledger(seen);
    const out = await writer(db, (target, request, session) => complete(target, request, session, { fetch: fetchFn, db: spend }));
    expect(out).toMatchObject({ ok: true, status: "drafted" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.model).toBe("muse-wonder-1.0");
    expect(body.max_output_tokens).toBe(1_600);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "quarter_review", strict: true });
    expect(seen.reserved).toBeGreaterThan(0);
    expect(seen.reserved).toBeLessThanOrEqual(flags.quarterReviewLimits.maxReviewCents * NANOCENTS_PER_CENT);
    expect(briefs[0]).toMatchObject({ status: "drafted" });
  });

  it("the full figure pack at its input cap still fits the cost cap, so the call is not refused as too expensive", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => Response.json({ id: "r", status: "failed" }, { status: 503 }));
    const seen = { reserved: 0 };
    const { figures } = await seeded();
    // Every figure, padded to the input cap with three-byte characters in a customer's name.
    const pad = "一".repeat(Math.max(0, flags.quarterReviewLimits.maxInputChars - figuresText(figures).length - 80));
    const big: BriefFigure[] = [...figures, { ...figures[figures.length - 1], key: `f${figures.length + 1}`, label: `Customer ${pad}` }];
    const request = quarterRequest(packFigures(big, flags.quarterReviewLimits.maxInputChars), "0c0c0c0c-0000-4000-8000-000000000001");
    await expect(complete("wonder", request, SESSION, { fetch: fetchFn, db: ledger(seen) })).rejects.toMatchObject({
      category: "unavailable",
    });
    // The request went out (a 503 came back), so the worst case fit the cap.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(seen.reserved).toBeGreaterThan(0);
    expect(seen.reserved).toBeLessThanOrEqual(flags.quarterReviewLimits.maxReviewCents * NANOCENTS_PER_CENT);
  });
});

// ---- The agent's read tool ----

describe("get_quarter_review", () => {
  const ctx: GatewayContext = {
    session: SESSION,
    role: "operator",
    model: "spark",
    turnId: null,
    traceId: "trace-quarter",
    now: NOW,
    deadlineAt: NOW.getTime() + 60_000,
    timeZone: TZ,
  };
  const run = (db: FakeDb) => db.withTenant(TENANT, (q) => getQuarterReview.run(q, ctx, {}, { screen: null, limit: null }));

  it("reads the quarter so far as the page does, and no review before one is written", async () => {
    flags.quarterReviewEnabled = true;
    const { db } = writerDb();
    const view = await db.withTenant(TENANT, (q) => readQuarterView(q, PLAN_ANCHOR, TZ, 40_000, NOW));
    const out = (await run(db)).result as Record<string, Record<string, unknown> | unknown[] | null>;
    expect(out.quarter).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(out.soFar).toEqual({ start: "2026-10-01", end: PLAN_ANCHOR });
    expect(out.payRuns).toMatchObject({ runs: 4, paid: 3, open: 1, netCents: view.quarter.pay.netCents });
    expect(out.margin).toMatchObject({ revenueCents: view.quarter.margin.revenueCents, marginBps: view.quarter.margin.marginBps });
    expect(out.recovered).toEqual(view.quarter.recovered);
    expect((out.customers as unknown[]).length).toBe(Math.min(12, view.quarter.customers.length));
    expect(out.review).toBeNull();
  });

  it("returns a written review's lists as plain words with no tags", async () => {
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = true;
    const { db } = writerDb();
    const { figures } = await seeded();
    await writer(db, async () => answer(replyFrom(figures)));
    const out = (await run(db)).result as { review: Record<string, unknown> | null };
    expect(out.review).not.toBeNull();
    expect(out.review?.figuresChangedSince).toBe(false);
    for (const s of QUARTER_SECTIONS) {
      const items = out.review?.[s] as string[];
      expect(items.length, s).toBeGreaterThan(0);
      for (const item of items) expect(item).not.toMatch(/\[f\d+\]/);
    }
    expect((out.review?.change as string[])[0]).toContain(figureValueText(figures.find((f) => f.label === "Open receivables past due") as BriefFigure));
  });

  it("is off with its switch", async () => {
    flags.quarterReviewEnabled = false;
    await expect(run(writerDb().db)).rejects.toThrow("switched off");
    expect(getQuarterReview.enabled?.()).toBe(false);
  });
});
