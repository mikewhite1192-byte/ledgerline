import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { TENANT } from "../agent/gateway/__tests__/fake-db";
import { blueRidgePlan, planDb } from "../agent/gateway/__tests__/plan-db";
import { capResult } from "../agent/gateway";
import { fitResult, REPORT_RESULT_CHARS } from "../agent/gateway/tools/read/report-tool";
import { reportTrustMeter } from "../agent/gateway/tools/read/report-trust-meter";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { TRUST_PAGING } from "../data/read";
import { addDays, dayOfWeek } from "../time/local-date";
import { parseReportArgs } from "./args";
import { computeReport, type ReportClock } from "./run";
import { ReportsOffError } from "./switch";
import {
  bucketWeeks,
  classify,
  computeTrustMeter,
  DISPLAY_ONLY_NOTE,
  TRUST_MAX_MISSED_BPS,
  TRUST_MIN_PASSED,
  TRUST_MIN_RATE_SAMPLE,
  TRUST_WINDOW_WEEKS,
  TRUST_Z,
  trustReadWindow,
  trustReady,
  verdictNotes,
  wilsonUpperBps,
  type TrustDecision,
} from "./trust-meter";
import { REPORT_COLUMNS, type ReportResult } from "./types";

// The review trust meter from hand-built decisions (what counts, the weeks, the bound, the notes)
// and from the Blue Ridge seed plan through the real readers. No test reads the wall clock: every
// date is fixed.

const CHICAGO = "America/Chicago";
const TOKYO = "Asia/Tokyo";
const AS_OF = "2026-11-02";

// A decision that passed both checks and was approved, unless the test says otherwise.
function decision(over: Partial<TrustDecision> = {}): TrustDecision {
  return {
    kind: "advance_payout",
    status: "done",
    decidedAt: "2026-10-28T15:00:00.000Z",
    decisionNote: null,
    auditorVerdict: "pass",
    engineCheck: "matched",
    auditorOverridden: false,
    engineOverridden: false,
    ...over,
  };
}

const many = (n: number, over: Partial<TrustDecision> = {}): TrustDecision[] =>
  Array.from({ length: n }, () => decision(over));

const run = (decisions: readonly TrustDecision[], weekStartDow: number | null = 1, timeZone = CHICAGO) =>
  computeTrustMeter({ decisions, weekStartDow }, AS_OF, timeZone);

describe("trust_meter: what counts", () => {
  const yes = { decided: true };
  it.each([
    ["approved, both checks passed", {}, { ...yes, checked: true, passed: true }],
    ["executing, passed", { status: "executing" }, { ...yes, checked: true, passed: true }],
    ["approved, passed", { status: "approved" }, { ...yes, checked: true, passed: true }],
    ["failed after approval: not an error", { status: "failed" }, { ...yes, checked: true, passed: true }],
    [
      "declined as the wrong amount after passing",
      { status: "rejected", decisionNote: "wrong_amount" },
      { ...yes, checked: true, passed: true, wrong: true, missed: true },
    ],
    [
      "declined as the wrong record after passing",
      { status: "rejected", decisionNote: "wrong_record" },
      { ...yes, checked: true, passed: true, wrong: true, missed: true },
    ],
    ["declined as not needed", { status: "rejected", decisionNote: "not_needed" }, { ...yes, checked: true, passed: true, declined: true }],
    ["declined to review", { status: "rejected", decisionNote: "needs_review" }, { ...yes, checked: true, passed: true, declined: true }],
    ["declined for another reason", { status: "rejected", decisionNote: "other" }, { ...yes, checked: true, passed: true, declined: true }],
    ["declined with no category", { status: "rejected", decisionNote: null }, { ...yes, checked: true, passed: true, declined: true }],
    [
      "a category that only starts like a wrong one",
      { status: "rejected", decisionNote: "wrong_amount_maybe" },
      { ...yes, checked: true, passed: true, declined: true },
    ],
    [
      "concerns, then declined as wrong: the check worked",
      { status: "rejected", decisionNote: "wrong_amount", auditorVerdict: "concerns" },
      { ...yes, checked: true, flagged: true, wrong: true },
    ],
    [
      "a block approved over",
      { auditorVerdict: "block", auditorOverridden: true },
      { ...yes, checked: true, flagged: true, overridden: true },
    ],
    [
      "a recompute mismatch approved over",
      { engineCheck: "mismatch", engineOverridden: true },
      { ...yes, checked: true, flagged: true, overridden: true },
    ],
    ["the recompute unavailable: checked, not passed", { engineCheck: "unavailable" }, { ...yes, checked: true }],
    ["no recompute stored: checked, not passed", { engineCheck: null }, { ...yes, checked: true }],
    [
      "never checked: decided only",
      { auditorVerdict: null, status: "rejected", decisionNote: "wrong_amount" },
      { ...yes, wrong: true },
    ],
    ["the check unknown: decided only", { auditorVerdict: "unknown" }, yes],
    [
      "unknown check with a mismatch: flagged, never checked",
      { auditorVerdict: "unknown", engineCheck: "mismatch" },
      { ...yes, flagged: true },
    ],
    ["expired by the approve gate: nothing", { status: "expired", decisionNote: "expired" }, {}],
    ["superseded: nothing", { status: "expired", decisionNote: "superseded" }, {}],
    ["still open: nothing", { status: "proposed", decidedAt: null }, {}],
  ] as const)("%s", (_, over, want) => {
    expect(classify(decision(over as Partial<TrustDecision>))).toEqual({
      decided: false,
      checked: false,
      flagged: false,
      passed: false,
      wrong: false,
      missed: false,
      overridden: false,
      declined: false,
      ...want,
    });
  });

  it("refuses a status, verdict or recompute result outside the stored sets, never counting it", () => {
    expect(() => classify(decision({ status: "Done" }))).toThrow(/status/);
    expect(() => classify(decision({ auditorVerdict: "passed" }))).toThrow(/verdict/);
    expect(() => classify(decision({ engineCheck: "match" }))).toThrow(/recompute/);
    expect(() => run([decision({ kind: "advance" })])).toThrow(/kind/);
  });
});

describe("trust_meter: the weeks", () => {
  it("holds exactly 26 weeks ending with the week holding asOf, and drops the week before", () => {
    const weeks = bucketWeeks(AS_OF, 1);
    expect(weeks).toHaveLength(TRUST_WINDOW_WEEKS);
    expect(weeks.at(-1)).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(weeks[0]).toEqual({ start: "2026-05-11", end: "2026-05-17" });
    for (let i = 1; i < weeks.length; i += 1) expect(weeks[i].start).toBe(addDays(weeks[i - 1].end, 1));
    // Noon in Chicago on the first day counts; the day before does not.
    const r = run([
      decision({ decidedAt: "2026-05-11T17:00:00.000Z" }),
      decision({ decidedAt: "2026-05-10T17:00:00.000Z" }),
      decision({ decidedAt: "2026-11-08T17:00:00.000Z" }),
      decision({ decidedAt: "2026-11-09T17:00:00.000Z" }),
    ]);
    expect(r.rows.map((row) => [row.weekStart, row.decided])).toEqual([
      ["2026-05-11", 1],
      ["2026-11-02", 1],
    ]);
    expect(r.period).toEqual({ start: "2026-05-11", end: "2026-11-08" });
  });

  it("reads a little past the window either side, so every zone's days are covered", () => {
    expect(trustReadWindow(bucketWeeks(AS_OF, 1))).toEqual({
      start: "2026-05-10T00:00:00.000Z",
      end: "2026-11-10T00:00:00.000Z",
    });
    expect(() => trustReadWindow([])).toThrow(RangeError);
  });

  it("places a decision by the carrier's own date: 03:30Z on a Sunday is Saturday in Chicago, Sunday in Tokyo", () => {
    const sunday = "2026-10-25T03:30:00.000Z";
    expect(dayOfWeek("2026-10-25")).toBe(0);
    // Weeks that start on Sunday: Chicago's Saturday is the week before.
    const chicago = run([decision({ decidedAt: sunday })], 0, CHICAGO);
    const tokyo = run([decision({ decidedAt: sunday })], 0, TOKYO);
    expect(chicago.rows.map((row) => row.weekStart)).toEqual(["2026-10-18"]);
    expect(tokyo.rows.map((row) => row.weekStart)).toEqual(["2026-10-25"]);
  });

  it("starts the weeks on the pay rules' day, or on Monday with a note when no rules are on file", () => {
    const friday = run([decision()], 5);
    expect(friday.rows.map((row) => row.weekStart)).toEqual(["2026-10-23"]);
    expect(dayOfWeek(friday.rows[0].weekStart as string)).toBe(5);
    expect(friday.notes?.some((n) => n.includes("Monday"))).toBe(false);
    const fallback = run([decision()], null);
    expect(fallback.rows.map((row) => row.weekStart)).toEqual(["2026-10-26"]);
    expect(dayOfWeek(fallback.rows[0].weekStart as string)).toBe(1);
    expect(fallback.notes).toContain("No pay rules are on file, so the weeks run Monday to Sunday.");
  });

  it("lists action types A to Z by their label, then weeks oldest first, and no row for an empty week", () => {
    const r = run([
      decision({ kind: "settlement_approve", decidedAt: "2026-10-28T15:00:00.000Z" }),
      decision({ kind: "advance_payout", decidedAt: "2026-10-28T15:00:00.000Z" }),
      decision({ kind: "advance_payout", decidedAt: "2026-10-07T15:00:00.000Z" }),
      decision({ kind: "invoice_post", decidedAt: "2026-10-14T15:00:00.000Z" }),
    ]);
    expect(r.rows.map((row) => [row.actionType, row.weekStart])).toEqual([
      ["Approve weekly pay", "2026-10-26"],
      ["Pay advance", "2026-10-05"],
      ["Pay advance", "2026-10-26"],
      ["Post invoice", "2026-10-12"],
    ]);
    expect(r.subtotals?.map((s) => s.label)).toEqual([
      "Approve weekly pay",
      "Pay advance",
      "Post invoice",
    ]);
    expect(r.trust?.map((t) => t.kind)).toEqual(["settlement_approve", "advance_payout", "invoice_post"]);
    // No total across action types: one rate over all of them would hide the one that is not ready.
    expect(r).not.toHaveProperty("totals");
  });
});

describe("trust_meter: the bound", () => {
  it("pins the worked values, each checked against the formula", () => {
    expect(wilsonUpperBps(0, 200)).toBe(189);
    expect(wilsonUpperBps(0, 150)).toBe(250);
    expect(wilsonUpperBps(1, 200)).toBe(278);
    expect(wilsonUpperBps(1, 400)).toBe(141);
    expect(trustReady(200, wilsonUpperBps(0, 200))).toBe(true);
    expect(trustReady(150, wilsonUpperBps(0, 150))).toBe(false);
    expect(trustReady(200, wilsonUpperBps(1, 200))).toBe(false);
    expect(trustReady(400, wilsonUpperBps(1, 400))).toBe(true);
    // With no misses the Wilson bound is z^2 / (n + z^2), rounded up.
    const z2 = TRUST_Z * TRUST_Z;
    for (const n of [1, 20, 150, 199, 200, 1000]) {
      expect(wilsonUpperBps(0, n), String(n)).toBe(Math.ceil((10_000 * z2) / (n + z2)));
    }
  });

  it("is ready at exactly 200 passed and a bound of exactly 2%, and not one under either", () => {
    expect(TRUST_MIN_PASSED).toBe(200);
    expect(TRUST_MAX_MISSED_BPS).toBe(200);
    expect(trustReady(200, wilsonUpperBps(0, 200))).toBe(true);
    expect(trustReady(199, wilsonUpperBps(0, 199))).toBe(false);
    expect(wilsonUpperBps(1, 280)).toBe(200);
    expect(trustReady(280, wilsonUpperBps(1, 280))).toBe(true);
    expect(wilsonUpperBps(1, 279)).toBe(201);
    expect(trustReady(279, wilsonUpperBps(1, 279))).toBe(false);
    expect(trustReady(500, null)).toBe(false);
  });

  it("never falls with more misses, and never rises with more passes at the same misses", () => {
    for (const n of [1, 7, 20, 200, 401]) {
      let before = -1;
      for (let k = 0; k <= n; k += 1) {
        const bps = wilsonUpperBps(k, n);
        expect(bps, `${k}/${n}`).toBeGreaterThanOrEqual(before);
        expect(bps).toBeGreaterThan(0);
        expect(bps).toBeLessThanOrEqual(10_000);
        before = bps;
      }
    }
    for (const k of [0, 1, 3]) {
      let before = 10_001;
      for (let n = Math.max(k, 1); n <= 600; n += 1) {
        const bps = wilsonUpperBps(k, n);
        expect(bps, `${k}/${n}`).toBeLessThanOrEqual(before);
        before = bps;
      }
    }
    expect(wilsonUpperBps(5, 5)).toBe(10_000);
  });

  it("refuses a rate over nothing, more misses than passes and anything not a whole count", () => {
    expect(() => wilsonUpperBps(0, 0)).toThrow(RangeError);
    expect(() => wilsonUpperBps(3, 2)).toThrow(RangeError);
    expect(() => wilsonUpperBps(-1, 20)).toThrow(RangeError);
    expect(() => wilsonUpperBps(0.5, 20)).toThrow(RangeError);
    expect(() => wilsonUpperBps(0, 20.5)).toThrow(RangeError);
  });
});

describe("trust_meter: small samples", () => {
  it("leaves the rate blank under 20 passed in a row or a subtotal, never 0%", () => {
    const weekOf = (day: string) => `${day}T15:00:00.000Z`;
    const three = [
      ...many(7, { decidedAt: weekOf("2026-10-14") }),
      ...many(6, { decidedAt: weekOf("2026-10-21") }),
      ...many(6, { decidedAt: weekOf("2026-10-28") }),
    ];
    const r = run(three);
    expect(r.rows.map((row) => row.passed)).toEqual([7, 6, 6]);
    expect(r.rows.every((row) => row.missedBps === null)).toBe(true);
    expect(r.subtotals?.[0].totals.passed).toBe(19);
    expect(r.subtotals?.[0].totals).not.toHaveProperty("missedBps");
    expect(TRUST_MIN_RATE_SAMPLE).toBe(20);
    // One more passed decision, declined as wrong, makes the window's rate computable: 1 of 20.
    const twenty = run([...three, decision({ status: "rejected", decisionNote: "wrong_record", decidedAt: weekOf("2026-10-28") })]);
    expect(twenty.subtotals?.[0].totals).toMatchObject({ passed: 20, missed: 1, missedBps: 500 });
    expect(twenty.rows.at(-1)).toMatchObject({ passed: 7, missed: 1, missedBps: null });
  });

  it("does not count a decision never checked toward the rate", () => {
    const r = run([...many(25, { auditorVerdict: null }), ...many(25, { auditorVerdict: "unknown" })]);
    expect(r.rows[0]).toMatchObject({ decided: 50, checked: 0, passed: 0, missed: 0, missedBps: null });
    expect(r.trust).toEqual([{ kind: "advance_payout", upperBps: null, ready: false }]);
  });
});

describe("trust_meter: the notes", () => {
  it("says a record would support exception-only review only when it meets the bar", () => {
    const decisions = [
      ...many(290),
      ...many(14, { status: "rejected", decisionNote: "not_needed", auditorVerdict: "concerns" }),
      ...many(3, { status: "done", auditorVerdict: "block", auditorOverridden: true }),
      ...many(5, { auditorVerdict: "unknown" }),
    ];
    const r = run(decisions);
    expect(r.notes?.[0]).toBe(DISPLAY_ONLY_NOTE);
    expect(r.notes?.at(-1)).toBe(
      "Would support exception-only review, with at least 200 passed and at most 2%: Pay advance (at most 1.31%).",
    );
    expect(r.trust).toEqual([{ kind: "advance_payout", upperBps: 131, ready: true }]);
    // The counts behind the verdict are the subtotal of the same label.
    expect(r.subtotals).toHaveLength(1);
    expect(r.subtotals?.[0]).toMatchObject({ label: "Pay advance", totals: { decided: 312, passed: 290, missed: 0 } });
  });

  it("says too few to say under 200 passed, whatever the misses", () => {
    const r = run([...many(61, { kind: "invoice_post" })]);
    expect(r.notes?.at(-1)).toBe("Too few to say, under 200 passed: Post invoice (61 passed).");
    expect(r.trust).toEqual([{ kind: "invoice_post", upperBps: 593, ready: false }]);
  });

  it("says not yet when the bound is over 2%", () => {
    const r = run([
      ...many(248, { kind: "settlement_approve" }),
      ...many(2, { kind: "settlement_approve", status: "rejected", decisionNote: "wrong_amount" }),
    ]);
    expect(r.notes?.at(-1)).toBe("Not yet, over 2%: Approve weekly pay (at most 2.87%).");
    expect(r.trust).toEqual([{ kind: "settlement_approve", upperBps: 287, ready: false }]);
  });

  it("groups the verdicts into at most three lines, ready first, each type whole in its own line", () => {
    const r = run([
      ...many(61, { kind: "invoice_post" }),
      ...many(290),
      ...many(248, { kind: "settlement_approve" }),
      ...many(2, { kind: "settlement_approve", status: "rejected", decisionNote: "wrong_amount" }),
      ...many(5, { kind: "escrow_release" }),
    ]);
    expect(r.notes?.slice(3)).toEqual([
      "Would support exception-only review, with at least 200 passed and at most 2%: Pay advance (at most 1.31%).",
      "Not yet, over 2%: Approve weekly pay (at most 2.87%).",
      "Too few to say, under 200 passed: Post invoice (61 passed); Release driver escrow (5 passed).",
    ]);
    expect(r.trust?.map((t) => t.ready)).toEqual([false, true, false, false]);
    expect(verdictNotes([])).toEqual([]);
  });

  it("explains the percent and what is not counted as an error, once", () => {
    const r = run(many(3));
    expect(r.notes?.[2]).toBe(
      "The percent after an action type is the most its missed rate could be at 95% confidence. Cards declined for " +
        "other reasons and cards approved over a flag are not counted as errors.",
    );
  });

  it("keeps the display-only note first and the definitions on an empty result", () => {
    const r = run([]);
    expect(r.rows).toEqual([]);
    expect(r.emptyReason).toBe("no_rows");
    expect(r.notes?.[0]).toBe(DISPLAY_ONLY_NOTE);
    expect(r.notes).toHaveLength(3);
    expect(r.notes?.[1]).toMatch(/^Wrong means a person declined/);
    expect(r.notes?.[2]).toMatch(/^The percent after an action type/);
    expect(r.trust).toEqual([]);
    expect(r).not.toHaveProperty("subtotals");
    // Only expired cards in the window are no decision at all.
    const expired = run(many(3, { status: "expired", decisionNote: "superseded" }));
    expect(expired.emptyReason).toBe("no_rows");
    expect(expired.notes?.[0]).toBe(DISPLAY_ONLY_NOTE);
  });

  it("holds no cents key or figure anywhere, and none of its notes names a dollar amount", () => {
    const r = run([...many(30), ...many(2, { status: "rejected", decisionNote: "wrong_amount" })]);
    expect(JSON.stringify(r)).not.toMatch(/Cents/);
    expect(REPORT_COLUMNS.trust_meter.map((col) => col.kind)).not.toContain("cents");
    for (const note of r.notes ?? []) expect(note).not.toMatch(/\$|\bcents?\b|dollar/i);
  });
});

describe("trust_meter: a tool result cut to fit", () => {
  // Action types the result has room for beyond the ones the app has today.
  const ROOM_FOR_KINDS = 8;
  const READ_CAP = TRUST_PAGING.pageSize * TRUST_PAGING.maxPages;

  // The most decisions the reader returns, spread evenly over every action type the app has and
  // every week, a few wrong in each type, and no pay rules on file (one more note): the widest
  // counts and the most action types one result can hold.
  function atReadCap(): ReportResult {
    const each = Math.floor(READ_CAP / PROPOSAL_KINDS.length);
    const weeks = bucketWeeks(AS_OF, 1);
    const decisions: TrustDecision[] = [];
    for (const kind of PROPOSAL_KINDS) {
      for (let i = 0; i < each; i += 1) {
        const wrong = i % 1000 === 0;
        decisions.push(
          decision({
            kind,
            decidedAt: `${weeks[i % weeks.length].start}T15:00:00.000Z`,
            auditorVerdict: i % 97 === 0 ? "concerns" : "pass",
            ...(wrong ? { status: "rejected", decisionNote: "wrong_amount" } : {}),
          }),
        );
      }
    }
    return run(decisions, null);
  }

  // The same result with more action types, each a copy of the largest one there is.
  function withMoreKinds(r: ReportResult, more: number): ReportResult {
    const subtotals = r.subtotals ?? [];
    const trust = r.trust ?? [];
    const size = (i: number) => JSON.stringify(subtotals[i]).length + JSON.stringify(trust[i]).length;
    const largest = subtotals.reduce((best, _, i) => (size(i) > size(best) ? i : best), 0);
    const allSubtotals = [...subtotals, ...Array.from({ length: more }, () => subtotals[largest])];
    const allTrust = [...trust, ...Array.from({ length: more }, () => trust[largest])];
    const judged = allSubtotals.map((s, i) => ({ label: s.label, passed: s.totals.passed, upperBps: allTrust[i].upperBps }));
    const fixed = (r.notes ?? []).slice(0, (r.notes ?? []).length - verdictNotes(judged.slice(0, subtotals.length)).length);
    return { ...r, subtotals: allSubtotals, trust: allTrust, notes: [...fixed, ...verdictNotes(judged)] };
  }

  type Fitted = { rows: unknown[]; truncated: boolean; subtotals: unknown; trust: unknown; notes: unknown };

  it("keeps every action type the app has whole at the read cap, cutting only rows", () => {
    const r = atReadCap();
    expect(r.trust).toHaveLength(PROPOSAL_KINDS.length);
    expect(r.subtotals).toHaveLength(PROPOSAL_KINDS.length);
    const fitted = fitResult(r) as Fitted;
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(REPORT_RESULT_CHARS);
    expect(fitted.truncated).toBe(true);
    expect(fitted.rows.length).toBeLessThan(r.rows.length);
    expect(fitted.subtotals).toEqual(r.subtotals);
    expect(fitted.trust).toEqual(r.trust);
    expect(fitted.notes).toEqual(r.notes);
    // The gateway passes it on as it is.
    expect(capResult(fitted)).toMatchObject({ result: fitted, truncated: false });
  });

  it("has room for more action types than the app has today", () => {
    const r = withMoreKinds(atReadCap(), ROOM_FOR_KINDS);
    expect(r.trust).toHaveLength(PROPOSAL_KINDS.length + ROOM_FOR_KINDS);
    const fitted = fitResult(r) as Fitted;
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(REPORT_RESULT_CHARS);
    expect(fitted.trust).toEqual(r.trust);
    expect(fitted.notes).toEqual(r.notes);
    expect(fitted.subtotals).toEqual(r.subtotals);
  });

  it("sends no verdict at all when the action types alone do not fit, never a cut one", () => {
    const r = withMoreKinds(atReadCap(), PROPOSAL_KINDS.length * 2);
    const fitted = fitResult(r) as Fitted;
    expect(fitted.rows).toEqual([]);
    expect(JSON.stringify(fitted).length).toBeGreaterThan(REPORT_RESULT_CHARS);
    expect(fitted.trust).toEqual(r.trust);
    expect(capResult(fitted).result).toEqual({
      truncated: true,
      note: "The result was too large to return. Narrow the request.",
    });
  });
});

describe("trust_meter on the Blue Ridge seed plan", () => {
  const plan = blueRidgePlan();
  const CLOCK: ReportClock = { now: new Date(Date.UTC(2026, 10, 2, 17, 0, 0)), timeZone: plan.carrier.timezone };
  const SESSION: Session = { sub: "sub-1", email: "", tenantId: TENANT };
  const ctx = {
    session: SESSION,
    turnId: "t-1",
    now: CLOCK.now,
    timeZone: CLOCK.timeZone,
  } as Parameters<typeof reportTrustMeter.run>[1];
  const request = (args: Record<string, string>) => {
    const parsed = parseReportArgs("trust_meter", args);
    if (!parsed) throw new Error("bad test args");
    return parsed;
  };
  // Proposals as the table holds them; the seed plan has none of its own.
  const proposal = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: "advance_payout",
    status: "done",
    decided_at: "2026-10-28T15:00:00.000Z",
    decision_note: null,
    auditor_verdict: "pass",
    engine_check: "matched",
    auditor_override_reason: null,
    engine_override_reason: null,
    ...over,
  });
  const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const withProposals = (rows: Record<string, unknown>[]) => {
    const db = planDb(plan);
    db.tables.proposals = rows;
    return db;
  };

  beforeEach(() => {
    flags.trustMeterEnabled = true;
  });
  afterEach(() => {
    flags.trustMeterEnabled = false;
    flags.iftaEnabled = false;
    flags.yearEndEnabled = false;
  });

  it("reads the decisions through the real reader, in the plan's pay weeks, and nothing else", async () => {
    const db = withProposals([
      proposal(ids(1)),
      proposal(ids(2), { status: "rejected", decision_note: "wrong_amount" }),
      proposal(ids(3), { auditor_verdict: "block", auditor_override_reason: "checked the driver's receipt" }),
      proposal(ids(4), { status: "expired", decision_note: "expired" }),
      proposal(ids(5), { status: "proposed", decided_at: null }),
      proposal(ids(6), { decided_at: "2026-01-05T15:00:00.000Z" }),
    ]);
    const r = await db.withTenant(TENANT, (q) => computeReport(q, request({ asOf: "2026-11-02" }), CLOCK));
    expect(r.rows).toEqual([
      {
        actionType: "Pay advance",
        weekStart: "2026-10-26",
        decided: 3,
        checked: 3,
        flagged: 1,
        passed: 2,
        wrong: 1,
        missed: 1,
        missedBps: null,
      },
    ]);
    expect(r.notes?.at(-1)).toBe("Too few to say, under 200 passed: Pay advance (2 passed).");
    // Every statement is a read, scoped to the tenant, and the override reason's text is never read.
    for (const s of db.statements) {
      expect(s.sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/i);
      expect(s.tenantId).toBe(TENANT);
    }
    const reads = db.statements.filter((s) => s.sql.includes("FROM proposals"));
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toContain("tenant_id = current_tenant_id()");
    expect(reads[0].sql).toContain("auditor_override_reason IS NOT NULL AS auditor_overridden");
    expect(reads[0].params.slice(0, 2)).toEqual(["2026-05-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z"]);
  });

  it("defaults asOf to today in the carrier's time zone", async () => {
    const r = await withProposals([]).withTenant(TENANT, (q) => computeReport(q, request({}), CLOCK));
    expect(r.asOf).toBe("2026-11-02");
    expect(r.args).toEqual({ asOf: "2026-11-02" });
    expect(r.emptyReason).toBe("no_rows");
    expect(r.notes?.[0]).toBe(DISPLAY_ONLY_NOTE);
  });

  it("is refused by computeReport itself while its own switch is off, even with the reports on", async () => {
    flags.trustMeterEnabled = false;
    expect(flags.reportsEnabled).toBe(true);
    const report = () => withProposals([]).withTenant(TENANT, (q) => computeReport(q, request({}), CLOCK));
    await expect(report()).rejects.toBeInstanceOf(ReportsOffError);
    // Another report's own switch does not open it.
    flags.iftaEnabled = true;
    flags.yearEndEnabled = true;
    await expect(report()).rejects.toBeInstanceOf(ReportsOffError);
  });

  it("offers the tool and runs it only while its switch is on, rechecked on the run", async () => {
    const call = () => withProposals([proposal(ids(1))]).withTenant(TENANT, (q) => reportTrustMeter.run(q, ctx, {}, { screen: null, limit: null }));
    expect(reportTrustMeter.tier).toBe("read");
    expect(reportTrustMeter.enabled?.()).toBe(true);
    const out = (await call()).result as { report: string; rows: unknown[]; trust: unknown[] };
    expect(out.report).toBe("trust_meter");
    expect(out.rows).toHaveLength(1);
    expect(out.trust).toHaveLength(1);
    flags.trustMeterEnabled = false;
    expect(reportTrustMeter.enabled?.()).toBe(false);
    await expect(call()).rejects.toBeInstanceOf(ReportsOffError);
    flags.trustMeterEnabled = true;
    flags.reportsEnabled = false;
    try {
      expect(reportTrustMeter.enabled?.()).toBe(false);
      await expect(call()).rejects.toBeInstanceOf(ReportsOffError);
    } finally {
      flags.reportsEnabled = true;
    }
  });
});
