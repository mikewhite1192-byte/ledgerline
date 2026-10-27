import { afterEach, describe, expect, it } from "vitest";
import { formatBps } from "../../components/agent/report-table";
import { flags } from "../../config/flags";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "../agent/gateway/__tests__/plan-db";
import { TENANT } from "../agent/gateway/__tests__/fake-db";
import { getProfitBrief } from "../agent/gateway/tools/read/get-profit-brief";
import type { GatewayContext } from "../agent/gateway/types";
import { parseReportArgs } from "../reports/args";
import { ratioBps } from "../reports/build";
import { computeReport } from "../reports/run";
import type { ReportResult, ReportRow } from "../reports/types";
import { marginBpsOf, profitTotals, type BriefFigure, type FigureSource } from "../rules-engine";
import { bpsText, closedWeeks, figuresText, figureValueText, profitWeek, readProfitInput } from "./figures";
import { briefLinks, briefPlainText } from "./render";
import { checkBriefText, MAX_BRIEF_CHARS, verifyBrief } from "./verify";
import { BRIEF_LEASE_MS, briefStateOf, figuresOf, readProfitView, type BriefRecord } from "./view";
import { CHECK_FAILED, refusalWords, writeOutcome } from "./words";
import { BRIEF_FORMAT, BRIEF_PURPOSE, briefRequest } from "./write";

// The profit brief's pure parts: the engine's week figures from the Blue Ridge seed plan through
// the real readers (no database), the number check every brief passes, the links a checked brief
// becomes, the page's state and its fixed words, and the agent's read tool.

const plan = blueRidgePlan();
const NOW = new Date(Date.UTC(2026, 10, 2, 17, 0, 0));
const CLOCK = { now: NOW, timeZone: plan.carrier.timezone };
const LIMITS = { maxLanes: 10, maxCustomers: 12 };
const db = () => planDb(plan);

const REPORT: FigureSource = { report: "margin_per_load", args: { periodStart: "2026-10-19", periodEnd: "2026-10-25" } };
const CUSTOMER = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// A small figure list by hand: totals, a route that lost money, a customer whose name holds a
// number word.
const FIGURES: BriefFigure[] = [
  { key: "f1", label: "Revenue", kind: "cents", value: 4_821_000, source: REPORT },
  { key: "f2", label: "Driver pay", kind: "cents", value: 3_010_000, source: REPORT },
  { key: "f3", label: "Margin", kind: "cents", value: 1_811_000, source: REPORT },
  { key: "f4", label: "Margin percent", kind: "bps", value: 3756, source: REPORT },
  { key: "f5", label: "Loads priced", kind: "int", value: 12, source: REPORT },
  {
    key: "f6",
    label: "Route Roanoke, VA to Charlotte, NC: margin",
    kind: "cents",
    value: -12_500,
    source: REPORT,
    subject: "Roanoke, VA to Charlotte, NC",
  },
  {
    key: "f7",
    label: "Customer Second Street Foods: average days to pay",
    kind: "int",
    value: 41,
    source: { table: "customers", id: CUSTOMER },
    subject: "Second Street Foods",
  },
];

const GOOD =
  "Revenue was $48,210.00 [f1] against driver pay of $30,100.00 [f2], a margin of $18,110.00 [f3] or " +
  "37.56% [f4] on 12 [f5] priced loads. Roanoke, VA to Charlotte, NC ran at a loss of $125.00 [f6]. " +
  "Second Street Foods takes 41 [f7] days to pay.";

const reply = (text: string) => JSON.stringify({ text });
const check = (text: string) => verifyBrief(reply(text), FIGURES);

function request(args: Record<string, string>) {
  const parsed = parseReportArgs("margin_per_load", args);
  if (!parsed) throw new Error("bad margin args");
  return parsed;
}

async function newestWeek() {
  const weeks = await db().withTenant(TENANT, (q) => closedWeeks(q, PLAN_ANCHOR));
  const week = weeks[0];
  if (!week) throw new Error("the plan has no closed week");
  return week;
}

describe("the week's figures", () => {
  it("marginLines and computeMarginPerLoad agree to the cent on the seeded week", async () => {
    const week = await newestWeek();
    const period = { start: week.start, end: week.end };
    const { lines } = await db().withTenant(TENANT, (q) => readProfitInput(q, period));
    const report: ReportResult = await db().withTenant(TENANT, (q) =>
      computeReport(q, request({ periodStart: week.start, periodEnd: week.end }), CLOCK),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => l.loadId)).toEqual(report.rows.map((r: ReportRow) => (r.load as { id: string }).id));
    report.rows.forEach((row, i) => {
      const line = lines[i];
      expect([line.revenueCents, line.driverPayCents, line.marginCents, line.marginBps, line.note]).toEqual([
        row.revenueCents,
        row.driverPayCents,
        row.marginCents,
        row.marginBps,
        row.note,
      ]);
    });
    const sums = report.totals ?? report.subtotals?.[0]?.totals;
    const totals = profitTotals(lines);
    expect(totals.loads).toBeGreaterThan(0);
    expect(sums?.revenueCents).toBe(totals.revenueCents);
    expect(sums?.driverPayCents).toBe(totals.driverPayCents);
    expect(sums?.marginCents).toBe(totals.marginCents);
    expect(sums?.marginBps ?? null).toBe(totals.marginBps);
  });

  it("offers only weeks that closed before today, newest first, at most four", async () => {
    const weeks = await db().withTenant(TENANT, (q) => closedWeeks(q, PLAN_ANCHOR));
    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks.length).toBeLessThanOrEqual(4);
    const starts = weeks.map((w) => w.start);
    expect(starts).toEqual([...starts].sort().reverse());
    const statuses = new Map(plan.rows.settlement_periods.map((p) => [p.id, p.status]));
    for (const w of weeks) {
      expect(w.end < PLAN_ANCHOR).toBe(true);
      expect(["approved", "paid"]).toContain(statuses.get(w.id));
    }
  });

  it("lists the totals first, numbers every figure in order, and sources customers to their record", async () => {
    const week = await newestWeek();
    const period = { start: week.start, end: week.end };
    const input = await db().withTenant(TENANT, (q) => readProfitInput(q, period));
    const profit = profitWeek(input, period, LIMITS);
    const { figures, totals } = profit;
    expect(figures.map((f) => f.key)).toEqual(figures.map((_, i) => `f${i + 1}`));
    expect(figures.slice(0, 3).map((f) => [f.label, f.value])).toEqual([
      ["Revenue", totals.revenueCents],
      ["Driver pay", totals.driverPayCents],
      ["Margin", totals.marginCents],
    ]);
    for (const f of figures) {
      expect(Number.isSafeInteger(f.value)).toBe(true);
      if (f.label.startsWith("Customer ")) expect("table" in f.source && f.source.table).toBe("customers");
      else expect(f.source).toEqual({ report: "margin_per_load", args: { periodStart: week.start, periodEnd: week.end } });
    }
    const routeRows = new Set(figures.filter((f) => f.label.startsWith("Route ")).map((f) => f.subject));
    expect(routeRows.size).toBe(Math.min(profit.routes.length, LIMITS.maxLanes));
    // Unpriced loads add to no sum and are listed with their reason.
    expect(totals.loads + profit.unpriced.length).toBe(totals.loadsDelivered);
    // The stored shape reads back whole.
    expect(figuresOf(JSON.parse(JSON.stringify(figures)) as unknown[])).toEqual(figures);
  });

  it("writes a percent from basis points the same way the report tables do, and divides the same way", () => {
    for (const bps of [0, 5, 99, 100, 3756, 10_000, -1, -125, -10_000]) expect(bpsText(bps)).toBe(formatBps(bps));
    for (const [part, whole] of [
      [1_811_000, 4_821_000],
      [-12_500, 210_000],
      [1, 3],
      [2, 3],
      [5, 0],
      [5, -10],
      [0, 100],
    ]) {
      expect(marginBpsOf(part, whole)).toBe(ratioBps(part, whole));
    }
  });

  it("writes the figure list one line a figure, money as dollars and a percent from basis points", () => {
    expect(figureValueText(FIGURES[5])).toMatch(/^[-−]\$125\.00$/);
    expect(figuresText(FIGURES.slice(0, 5))).toBe(
      [
        "[f1] Revenue: $48,210.00",
        "[f2] Driver pay: $30,100.00",
        "[f3] Margin: $18,110.00",
        "[f4] Margin percent: 37.56%",
        "[f5] Loads priced: 12",
      ].join("\n"),
    );
  });
});

describe("the brief's model request", () => {
  it("asks once, capped, for JSON with only the text, from the figures and nothing else", async () => {
    const week = await newestWeek();
    const period = { start: week.start, end: week.end };
    const profit = profitWeek(await db().withTenant(TENANT, (q) => readProfitInput(q, period)), period, LIMITS);
    const r = briefRequest(profit.figures, "trace-1");
    expect(r).toMatchObject({
      purpose: BRIEF_PURPOSE,
      reasoningEffort: "low",
      maxOutputTokens: flags.profitBriefLimits.maxOutputTokens,
      maxCostCents: flags.profitBriefLimits.maxBriefCents,
      traceId: "trace-1",
      format: BRIEF_FORMAT,
    });
    expect(r.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const user = r.messages[1].content;
    expect(user).toContain(figuresText(profit.figures));
    expect(user).toContain(`at most ${MAX_BRIEF_CHARS} characters`);
    // Names and figures only: no record id, no email, no driver.
    expect(user).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(user).not.toContain("@");
    for (const d of plan.rows.drivers) expect(user).not.toContain(d.last_name);
  });
});

describe("the number check", () => {
  it("passes a brief whose every number is its tagged figure", () => {
    const out = check(GOOD);
    expect(out.ok).toBe(true);
    expect(out.verification).toEqual({ category: null, cited: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"], numbers: 7 });
  });

  it("a brief with an untagged number is refused", () => {
    expect(check(`${GOOD} Fuel was $500.00.`)).toMatchObject({ ok: false, category: "untagged" });
    expect(check("Revenue was $48,210.00 [f1] for the week of Oct 19.")).toMatchObject({ ok: false, category: "untagged" });
    // A number the model added, even next to another number's tag, has no tag of its own.
    expect(check("Revenue was $48,210.00 and $30,100.00 [f2].")).toMatchObject({ ok: false, category: "untagged" });
    // A count in words is a number with no tag.
    expect(check("Revenue was $48,210.00 [f1] across two routes.")).toMatchObject({ ok: false, category: "untagged" });
  });

  it("refuses numbers written as words, whatever the word", () => {
    for (const words of [
      "One route lost money and zero customers paid late.",
      "Margin came from a quarter of loads.",
      "The first route led and the second trailed.",
      "Margin was half of revenue.",
      "Thousands of miles ran this week.",
      "Pay ran twice as high.",
      "Margin rose by a few basis points.",
      "Margin was up a dozen percent.",
    ]) {
      const text = `Revenue was $48,210.00 [f1]. ${words}`;
      expect(check(text), words).toMatchObject({ ok: false, category: "untagged" });
    }
  });

  it("refuses any number character that is not a plain digit", () => {
    for (const text of [
      "Revenue was $48,210.00 [f1], ½ of revenue.",
      "Margin was 12² [f3].",
      // f5 is 12: the superscript would otherwise ride along on a figure that matches.
      "Loads priced: 12² [f5].",
      "Loads priced: Ⅻ [f5].",
      "Loads priced: １２ [f5].",
    ]) {
      expect(check(text), text).toMatchObject({ ok: false, category: "format" });
    }
  });

  it("refuses a figure with a letter or a size right after it", () => {
    for (const text of [
      "Revenue was $48k [f1].",
      "Revenue was $48,210.00k [f1].",
      "Revenue was $48 K [f1].",
      "Revenue was $48,210.00 M [f1].",
      "Revenue was $48 grand [f1].",
      "Margin was 37.56%x [f4].",
      "Loads priced: 12th [f5].",
    ]) {
      expect(check(text), text).toMatchObject({ ok: false, category: "number_mismatch" });
    }
    // A word after the tag, or a unit before it, is not a size.
    expect(check("Second Street Foods takes 41 [f7] days to pay.").ok).toBe(true);
    expect(check("Second Street Foods takes 41 days [f7] to pay.").ok).toBe(true);
  });

  it("a brief citing a tag that does not exist is refused", () => {
    expect(check("Revenue was $48,210.00 [f99].")).toMatchObject({ ok: false, category: "unknown_tag" });
    expect(check("Revenue was $48,210.00 [source].")).toMatchObject({ ok: false, category: "unknown_tag" });
    expect(check("Revenue was $48,210.00 [F1].")).toMatchObject({ ok: false, category: "unknown_tag" });
  });

  it("a brief whose percent is not an engine bps is refused", () => {
    expect(check("Margin was 37.5% [f4].")).toMatchObject({ ok: false, category: "number_mismatch" });
    expect(check("Margin was 38% [f4].")).toMatchObject({ ok: false, category: "number_mismatch" });
    // A percent tagged to a money figure is not a percent the engine gave.
    expect(check("Margin was 37.56% [f3].")).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("refuses a number that is not its figure's value: a typo, a sum, a rounding, a wrong kind", () => {
    for (const text of [
      "Revenue was $48,211.00 [f1].",
      "Revenue and pay came to $78,310.00 [f1].",
      "Revenue was about $48,000.00 [f1].",
      "Revenue was $48,210.01 [f1].",
      "Loads priced: $12.00 [f5].",
      "Loads priced: 13 [f5].",
      "Revenue was 4821000 [f1].",
    ]) {
      expect(check(text), text).toMatchObject({ ok: false });
    }
    expect(check("Revenue and pay came to $78,310.00 [f1].")).toMatchObject({ category: "number_mismatch" });
  });

  it("holds the sign: a loss is said as a loss or a minus, and a gain never carries a minus", () => {
    expect(check("Roanoke, VA to Charlotte, NC made $125.00 [f6].")).toMatchObject({ ok: false, category: "number_mismatch" });
    expect(check("Roanoke, VA to Charlotte, NC came in at -$125.00 [f6].").ok).toBe(true);
    expect(check("Margin was -$18,110.00 [f3].")).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("needs a loss word in the loss's own clause, never one that belongs to the figure before it", () => {
    // f6 is below zero: the loss word before it belongs to f3, so f6 would read as a gain.
    expect(check("Lost $18,110.00 [f3]; margin $125.00 [f6].")).toMatchObject({ ok: false, category: "number_mismatch" });
    expect(check("A loss of $18,110.00 [f3], then $125.00 [f6].")).toMatchObject({ ok: false, category: "number_mismatch" });
    // A loss word in an earlier sentence or clause is not this figure's either.
    expect(check("We lost ground. Margin was $125.00 [f6].")).toMatchObject({ ok: false, category: "number_mismatch" });
    expect(check("No loss; margin was $125.00 [f6].")).toMatchObject({ ok: false, category: "number_mismatch" });
    const own = "Margin was $18,110.00 [f3]; Roanoke, VA to Charlotte, NC lost $125.00 [f6].";
    expect(check(own).ok).toBe(true);
    expect(check("Margin was $18,110.00 [f3] and Roanoke, VA to Charlotte, NC ran at a loss of $125.00 [f6].").ok).toBe(true);
  });

  it("reads the names a figure is about as names, never as numbers", () => {
    // "Second" in the name is a name here, not a number word.
    expect(check("Second Street Foods takes 41 [f7] days to pay.").ok).toBe(true);
    expect(check("Second Street Foods takes 9 [f7] days to pay.")).toMatchObject({ ok: false, category: "number_mismatch" });
    // A name never stands in for a loss word.
    const named = FIGURES.map((f) => (f.key === "f6" ? { ...f, subject: "Lost Creek Farms" } : f));
    expect(checkBriefText("Lost Creek Farms made $125.00 [f6].", named)).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("refuses words that use a name holding a number, since that number would go unchecked", () => {
    const named = (subject: string) => FIGURES.map((f) => (f.key === "f7" ? { ...f, subject } : f));
    expect(checkBriefText("Route 9 Foods takes 41 [f7] days to pay.", named("Route 9 Foods"))).toMatchObject({
      ok: false,
      category: "untagged",
    });
    const forged = named("Revenue was $999,999.00");
    expect(checkBriefText("Revenue was $999,999.00 and takes 41 [f7] days to pay.", forged)).toMatchObject({
      ok: false,
      category: "untagged",
    });
    // A name the words do not use hides nothing.
    expect(checkBriefText("Revenue was $48,210.00 [f1].", forged).ok).toBe(true);
  });

  it("refuses a reply that is not exactly the text it asked for", () => {
    for (const raw of [
      "Revenue was $48,210.00 [f1].",
      JSON.stringify({ text: GOOD, extra: 1 }),
      JSON.stringify({ body: GOOD }),
      JSON.stringify([GOOD]),
      JSON.stringify({ text: 5 }),
    ]) {
      expect(verifyBrief(raw, FIGURES), raw).toMatchObject({ ok: false, category: "format" });
    }
    for (const text of [
      "",
      "   ",
      `${GOOD} ${"More words. ".repeat(Math.ceil(MAX_BRIEF_CHARS / 12))}`,
      `${GOOD} See https://example.test.`,
      `${GOOD}​`,
      "A quiet week with nothing to cite.",
      "Revenue was $48,210.00 [f1] [unclosed",
    ]) {
      expect(check(text), text).toMatchObject({ ok: false });
    }
    expect(check("A quiet week with nothing to cite.")).toMatchObject({ category: "format" });
  });

  it("keeps no words on a refusal, only the category and what it counted", () => {
    const out = check(`${GOOD} Fuel was $500.00.`);
    expect(out).toEqual({ ok: false, category: "untagged", verification: expect.any(Object) });
    expect(JSON.stringify(out)).not.toContain("Fuel");
  });
});

describe("a checked brief on the page", () => {
  const hrefFor = (source: FigureSource) =>
    "table" in source ? `/records/${source.table}/${source.id}` : `/report/${source.report}.csv`;

  it("links each number to where it came from and drops the tags", () => {
    const pieces = briefLinks(GOOD, FIGURES, hrefFor);
    expect(pieces.map((p) => p.text).join("")).toBe(briefPlainText(GOOD));
    expect(pieces.map((p) => p.text).join("")).not.toMatch(/\[f\d+\]/);
    const linked = pieces.filter((p) => p.href !== null);
    expect(linked.map((p) => p.text)).toEqual([
      "$48,210.00",
      "$30,100.00",
      "$18,110.00",
      "37.56%",
      "12",
      "$125.00",
      "41",
    ]);
    expect(linked.at(-1)).toEqual({ text: "41", href: `/records/customers/${CUSTOMER}`, label: FIGURES[6].label });
    expect(linked[0].href).toBe("/report/margin_per_load.csv");
  });

  it("shows plain words with no links when the figures no longer read the brief the same way", () => {
    const moved = FIGURES.map((f) => (f.key === "f1" ? { ...f, value: 4_900_000 } : f));
    expect(briefLinks(GOOD, moved, hrefFor)).toEqual([{ text: briefPlainText(GOOD), href: null }]);
  });

  it("reads a tag with no number before it as a source link", () => {
    const text = "Second Street Foods paid slowest [f7].";
    expect(checkBriefText(text, FIGURES).ok).toBe(true);
    expect(briefLinks(text, FIGURES, hrefFor)).toEqual([
      { text: "Second Street Foods paid slowest ", href: null },
      { text: "(source)", href: `/records/customers/${CUSTOMER}`, label: FIGURES[6].label },
      { text: ".", href: null },
    ]);
  });
});

describe("the brief's state", () => {
  const record = (over: Partial<BriefRecord>): BriefRecord => ({
    id: "b1",
    status: "drafted",
    periodStart: "2026-10-19",
    periodEnd: "2026-10-25",
    asOf: "2026-11-02",
    figures: FIGURES,
    text: GOOD,
    category: null,
    updatedAt: NOW.toISOString(),
    ...over,
  });
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it("reads none, writing, refused and drafted, and marks a brief whose figures moved", () => {
    expect(briefStateOf([], FIGURES, NOW)).toEqual({ kind: "none" });
    expect(briefStateOf([record({ status: "superseded", text: null, category: "untagged" })], FIGURES, NOW)).toEqual({
      kind: "none",
    });
    expect(briefStateOf([record({ status: "drafting", text: null, updatedAt: ago(60_000) })], FIGURES, NOW)).toEqual({
      kind: "writing",
    });
    expect(briefStateOf([record({ status: "refused", text: null, category: "untagged" })], FIGURES, NOW)).toEqual({
      kind: "refused",
      category: "untagged",
    });
    expect(briefStateOf([record({})], FIGURES, NOW)).toMatchObject({ kind: "drafted", changed: false });
    const moved = FIGURES.map((f) => (f.key === "f2" ? { ...f, value: 3_000_000 } : f));
    expect(briefStateOf([record({})], moved, NOW)).toMatchObject({ kind: "drafted", changed: true });
  });

  it("reads a drafting row past its lease as cut off", () => {
    const stale = record({ status: "drafting", text: null, updatedAt: ago(BRIEF_LEASE_MS + 1000) });
    expect(briefStateOf([stale], FIGURES, NOW)).toEqual({ kind: "refused", category: "interrupted" });
  });

  it("refuses stored figures that are not the shape the engine writes", () => {
    const good = JSON.parse(JSON.stringify(FIGURES)) as Record<string, unknown>[];
    expect(figuresOf(good)).toEqual(FIGURES);
    for (const bad of [
      { ...good[0], kind: "dollars" },
      { ...good[0], value: 1.5 },
      { ...good[0], value: null },
      { ...good[0], source: { table: "drivers", id: CUSTOMER } },
      { ...good[0], source: { report: "ar_aging", args: {} } },
      { ...good[0], source: { report: "margin_per_load", args: { periodStart: "Oct 19", periodEnd: "2026-10-25" } } },
      { ...good[0], subject: 5 },
      null,
      "f1",
    ]) {
      expect(figuresOf([...good.slice(1), bad]), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the brief's words", () => {
  it("says the check failed for every check category, and nothing was lost for every other one", () => {
    for (const c of ["format", "unknown_tag", "number_mismatch", "untagged"]) expect(refusalWords(c)).toBe(CHECK_FAILED);
    for (const c of ["timeout", "interrupted", "incomplete", "cap", "too_expensive", "job_cap", "disabled", "error", "x"]) {
      expect(refusalWords(c), c).toContain("Nothing was lost or sent.");
    }
  });

  it("turns each reply into one fixed sentence, never the server's words", () => {
    const ok = (data: Record<string, unknown>) => ({ ok: true, error: null, data });
    const no = (error: string) => ({ ok: false, error, data: {} });
    expect(writeOutcome(ok({ status: "drafted" }))).toBe("The brief is written and every number checked.");
    expect(writeOutcome(ok({ status: "refused", category: "untagged" }))).toBe(CHECK_FAILED);
    expect(writeOutcome(ok({ status: "over_cap", category: "cap" }))).toContain("budget");
    expect(writeOutcome(no("exists"))).toBe("This week's brief is already written.");
    expect(writeOutcome(no("open_period"))).toContain("still open");
    expect(writeOutcome(no("brief_off"))).toBe("Profit brief is off for this carrier. Nothing was sent.");
    expect(writeOutcome(no("<script>"))).toBe("The brief could not be written. Nothing was lost or sent. Try again.");
  });

  it("uses the house words only", () => {
    const all = [
      CHECK_FAILED,
      ...["format", "timeout", "incomplete", "cap", "job_cap", "disabled", "x"].map(refusalWords),
      ...["exists", "in_progress", "open_period", "no_loads", "not_found", "brief_off", "ai_off", "forbidden", "unknown", "x"].map(
        (e) => writeOutcome({ ok: false, error: e, data: {} }),
      ),
    ].join(" ");
    expect(all).not.toMatch(/proposal|tenant|rules engine|verdict|\blane|\u2014/i);
  });
});

describe("get_profit_brief", () => {
  const saved = flags.profitBriefEnabled;
  afterEach(() => {
    flags.profitBriefEnabled = saved;
  });
  const ctx: GatewayContext = {
    session: { sub: "sub-1", email: "", tenantId: TENANT },
    role: "operator",
    model: "spark",
    turnId: null,
    traceId: "trace-profit",
    now: NOW,
    deadlineAt: NOW.getTime() + 60_000,
    timeZone: plan.carrier.timezone,
  };
  const run = (args: { periodStart?: string }) => db().withTenant(TENANT, (q) => getProfitBrief.run(q, ctx, args, { screen: null, limit: null }));

  it("reads the newest closed week's figures as the page does, and no brief before one is written", async () => {
    flags.profitBriefEnabled = true;
    const view = await db().withTenant(TENANT, (q) => readProfitView(q, PLAN_ANCHOR, null, LIMITS, NOW));
    const out = (await run({})).result as Record<string, unknown>;
    const totals = view.profit?.totals;
    expect(out.period).toEqual({ start: view.week?.start, end: view.week?.end });
    expect(out.totals).toEqual({
      revenueCents: totals?.revenueCents,
      driverPayCents: totals?.driverPayCents,
      marginCents: totals?.marginCents,
      marginBps: totals?.marginBps,
      loadsPriced: totals?.loads,
      loadsDelivered: totals?.loadsDelivered,
    });
    expect((out.routes as unknown[]).length).toBeLessThanOrEqual(flags.profitBriefLimits.maxLanes);
    expect(out.brief).toBeNull();
  });

  it("answers for no other week than the one asked, and is off with its switch", async () => {
    flags.profitBriefEnabled = true;
    const out = (await run({ periodStart: "2020-01-06" })).result as Record<string, unknown>;
    expect(out.period).toBeNull();
    expect(out.totals).toBeNull();
    expect((out.closedWeeks as unknown[]).length).toBeGreaterThan(0);
    flags.profitBriefEnabled = false;
    await expect(run({})).rejects.toThrow("switched off");
  });
});
