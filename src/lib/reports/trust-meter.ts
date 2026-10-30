import { PROPOSAL_TITLES } from "../agent/gateway/store/proposals";
import { PROPOSAL_KINDS, type ProposalKind } from "../agent/gateway/types";
import { addDays, localDateOf, periodContaining, type Instant, type LocalDate, type Period } from "../time/local-date";
import { argsOf, ratioBps, reportOf } from "./build";
import type { ReportResult, ReportRow, ReportSubtotal, TrustVerdict } from "./types";

// The review trust meter (design-trust-meter): for each action type the agent proposes, how often a
// card a person caught as wrong had passed both checks first, by the carrier's pay week, and whether
// the record is long and clean enough to support exception-only review. Display only: it reads the
// decisions as stored, writes nothing and changes nothing about who approves.

// The window, in pay weeks, ending with the week holding asOf.
export const TRUST_WINDOW_WEEKS = 26;
// A missed rate over fewer checked-and-passed decisions than this is blank, never 0%.
export const TRUST_MIN_RATE_SAMPLE = 20;
// The readiness bar (the owner's call, taken at its default): at least this many checked-and-passed
// decisions of one action type in the window, and the upper bound of its missed rate at most this
// many basis points (2%). Constants, not flags: changing the bar is a code change with a review.
export const TRUST_MIN_PASSED = 200;
export const TRUST_MAX_MISSED_BPS = 200;
// The Wilson score bound's z. 1.96 is the upper end of the two-sided 95% interval, which is the
// one-sided 97.5% upper bound, so the note says 97.5% confidence.
export const TRUST_Z = 1.96;
// The week start when no pay rules are on file: Monday.
export const TRUST_FALLBACK_WEEK_START = 1;
// The reject categories that say the card itself was wrong. Every other category is "declined":
// the carrier did not want it, which says nothing about the numbers.
export const WRONG_CATEGORIES: readonly string[] = ["wrong_amount", "wrong_record"];

const STATUSES = ["proposed", "approved", "rejected", "expired", "executing", "done", "failed"];
const VERDICTS = ["pass", "concerns", "block", "unknown"];
const ENGINE_CHECKS = ["matched", "mismatch", "unavailable"];

// One proposal as the trust meter reads it: its stored values only, the override reasons as
// present or not (their text is never read).
export type TrustDecision = {
  kind: string;
  status: string;
  decidedAt: Instant | null;
  decisionNote: string | null;
  auditorVerdict: string | null;
  engineCheck: string | null;
  auditorOverridden: boolean;
  engineOverridden: boolean;
};

export type TrustClass = {
  decided: boolean;
  checked: boolean;
  flagged: boolean;
  passed: boolean;
  wrong: boolean;
  missed: boolean;
  overridden: boolean;
  declined: boolean;
};

const NOTHING: TrustClass = {
  decided: false,
  checked: false,
  flagged: false,
  passed: false,
  wrong: false,
  missed: false,
  overridden: false,
  declined: false,
};

// What one proposal counts as, by whole-value compares. A status, verdict or engine check outside
// the stored sets is refused, never counted as anything: a value added later fails closed. A NULL
// or 'unknown' verdict was never independently checked, so it is decided but never checked or
// passed. Passed also needs the recompute to have matched: one that was unavailable (cut, refused,
// or a kind with no comparison) or never stored is unknown, not a pass. An expired or still open
// card counts for nothing: nobody judged it.
export function classify(d: TrustDecision): TrustClass {
  if (!STATUSES.includes(d.status)) throw new Error("a proposal status is not known");
  if (d.auditorVerdict !== null && !VERDICTS.includes(d.auditorVerdict)) {
    throw new Error("a check verdict is not known");
  }
  if (d.engineCheck !== null && !ENGINE_CHECKS.includes(d.engineCheck)) {
    throw new Error("a recompute result is not known");
  }
  if (d.decidedAt === null || d.status === "proposed" || d.status === "expired") return { ...NOTHING };
  const checked = d.auditorVerdict === "pass" || d.auditorVerdict === "concerns" || d.auditorVerdict === "block";
  const flagged = d.auditorVerdict === "concerns" || d.auditorVerdict === "block" || d.engineCheck === "mismatch";
  const passed = checked && d.engineCheck === "matched" && !flagged;
  const rejected = d.status === "rejected";
  const wrong = rejected && d.decisionNote !== null && WRONG_CATEGORIES.includes(d.decisionNote);
  return {
    decided: true,
    checked,
    flagged,
    passed,
    wrong,
    missed: wrong && passed,
    overridden: d.auditorOverridden || d.engineOverridden,
    declined: rejected && !wrong,
  };
}

// The TRUST_WINDOW_WEEKS pay weeks ending with the week holding asOf, oldest first.
export function bucketWeeks(asOf: LocalDate, weekStartDow: number): Period[] {
  const last = periodContaining(asOf, weekStartDow);
  return Array.from({ length: TRUST_WINDOW_WEEKS }, (_, i) => {
    const start = addDays(last.start, -7 * (TRUST_WINDOW_WEEKS - 1 - i));
    return { start, end: addDays(start, 6) };
  });
}

// The instants the window's local days can fall in: from the first day minus one to the last day
// plus two, as UTC midnights (start included, end not), so any zone from 12 hours behind UTC to 14
// ahead is covered. Each decision is then placed by its own local date, so the extra days never
// reach a count.
export function trustReadWindow(weeks: readonly Period[]): { start: Instant; end: Instant } {
  if (weeks.length === 0) throw new RangeError("the window has no weeks");
  return {
    start: `${addDays(weeks[0].start, -1)}T00:00:00.000Z`,
    end: `${addDays(weeks[weeks.length - 1].end, 2)}T00:00:00.000Z`,
  };
}

// The upper bound of a missed rate (missed of passed) by the Wilson score interval, rounded up to
// whole basis points. Floating point is fine here: this is a statistic, not money, and the result is
// a whole number. A rate over nothing is refused, never 0.
export function wilsonUpperBps(missed: number, passed: number): number {
  if (!Number.isSafeInteger(passed) || passed < 1) throw new RangeError("a rate needs at least one passed decision");
  if (!Number.isSafeInteger(missed) || missed < 0 || missed > passed) {
    throw new RangeError("the missed count must be 0 to the passed count");
  }
  const z2 = TRUST_Z * TRUST_Z;
  const p = missed / passed;
  const center = p + z2 / (2 * passed);
  const margin = TRUST_Z * Math.sqrt((p * (1 - p)) / passed + z2 / (4 * passed * passed));
  const upper = (center + margin) / (1 + z2 / passed);
  return Math.min(10_000, Math.ceil(upper * 10_000));
}

// Ready only with enough passed decisions and a bound at or under the bar.
export function trustReady(passed: number, upperBps: number | null): boolean {
  return passed >= TRUST_MIN_PASSED && upperBps !== null && upperBps <= TRUST_MAX_MISSED_BPS;
}

type Counts = {
  decided: number;
  checked: number;
  flagged: number;
  passed: number;
  wrong: number;
  missed: number;
};

const COUNT_KEYS = ["decided", "checked", "flagged", "passed", "wrong", "missed"] as const;

function zero(): Counts {
  return { decided: 0, checked: 0, flagged: 0, passed: 0, wrong: 0, missed: 0 };
}

function add(counts: Counts, c: TrustClass): void {
  for (const key of Object.keys(counts) as (keyof Counts)[]) if (c[key]) counts[key] += 1;
}

// The missed rate in basis points, or null under the sample floor.
function missedBpsOf(counts: Counts): number | null {
  return counts.passed >= TRUST_MIN_RATE_SAMPLE ? ratioBps(counts.missed, counts.passed) : null;
}

// 133 basis points is "1.33%", from the integer.
function percent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}

export const DISPLAY_ONLY_NOTE =
  "Display only. Every money action still needs a person's approval; this report changes nothing about who approves.";

const DEFINITION_NOTE =
  "Wrong means a person declined the card as the wrong amount or the wrong record. Passed means the " +
  "independent check passed and the pay recompute matched, and missed means a wrong card had " +
  `passed. The missed rate is missed over passed, blank under ${TRUST_MIN_RATE_SAMPLE} passed, so a ` +
  "rate over a few decisions never reads as 0%. A decision never checked is counted as decided only.";

// What the verdict lines mean, said once.
const VERDICT_NOTE =
  "The percent after an action type is the most its missed rate could be at 97.5% confidence. Cards " +
  "declined for other reasons and cards approved over a flag are not counted as errors.";

const MONDAY_NOTE = "No pay rules are on file, so the weeks run Monday to Sunday.";

const MAX_PERCENT = `${TRUST_MAX_MISSED_BPS / 100}%`;
const PASSED = TRUST_MIN_PASSED.toLocaleString("en-US");

// The verdict lines, at most three: the action types that would support exception-only review,
// those not yet, and those with too few passed to say, each type's own verdict whole inside its
// line. One line per verdict instead of one per type keeps every action type in one tool result
// (the subtotal of the same label holds its counts).
export function verdictNotes(verdicts: readonly { label: string; passed: number; upperBps: number | null }[]): string[] {
  const ready: string[] = [];
  const notYet: string[] = [];
  const tooFew: string[] = [];
  for (const v of verdicts) {
    if (v.passed < TRUST_MIN_PASSED || v.upperBps === null) {
      tooFew.push(`${v.label} (${v.passed.toLocaleString("en-US")} passed)`);
    } else {
      (trustReady(v.passed, v.upperBps) ? ready : notYet).push(`${v.label} (at most ${percent(v.upperBps)})`);
    }
  }
  const lines: string[] = [];
  if (ready.length > 0) {
    lines.push(
      `Would support exception-only review, with at least ${PASSED} passed and at most ${MAX_PERCENT}: ${ready.join("; ")}.`,
    );
  }
  if (notYet.length > 0) lines.push(`Not yet, over ${MAX_PERCENT}: ${notYet.join("; ")}.`);
  if (tooFew.length > 0) lines.push(`Too few to say, under ${PASSED} passed: ${tooFew.join("; ")}.`);
  return lines;
}

function labelOf(kind: ProposalKind): string {
  return PROPOSAL_TITLES[kind];
}

function kindOf(kind: string): ProposalKind {
  const found = PROPOSAL_KINDS.find((k) => k === kind);
  if (found === undefined) throw new Error("a proposal kind is not known");
  return found;
}

export type TrustInput = {
  decisions: readonly TrustDecision[];
  // From the pay rules in force on asOf; null when none are on file (a Monday week, and a note).
  weekStartDow: number | null;
};

export function computeTrustMeter(input: TrustInput, asOf: LocalDate, timeZone: string): ReportResult {
  const weekStartDow = input.weekStartDow ?? TRUST_FALLBACK_WEEK_START;
  const weeks = bucketWeeks(asOf, weekStartDow);
  const first = weeks[0].start;
  const last = weeks[weeks.length - 1].end;
  const byKind = new Map<ProposalKind, { total: Counts; weeks: Map<LocalDate, Counts> }>();
  for (const d of input.decisions) {
    const c = classify(d);
    if (!c.decided || d.decidedAt === null) continue;
    const day = localDateOf(d.decidedAt, timeZone);
    if (day < first || day > last) continue;
    const kind = kindOf(d.kind);
    const week = periodContaining(day, weekStartDow).start;
    let entry = byKind.get(kind);
    if (entry === undefined) {
      entry = { total: zero(), weeks: new Map() };
      byKind.set(kind, entry);
    }
    let counts = entry.weeks.get(week);
    if (counts === undefined) {
      counts = zero();
      entry.weeks.set(week, counts);
    }
    add(counts, c);
    add(entry.total, c);
  }
  // Action types A to Z by their label, then weeks oldest first. A week with no decision is not a
  // row: a missing week is not a zero.
  const kinds = [...byKind.keys()].sort((a, b) => labelOf(a).localeCompare(labelOf(b), "en-US"));
  const rows: ReportRow[] = [];
  const subtotals: ReportSubtotal[] = [];
  const trust: TrustVerdict[] = [];
  const judged: { label: string; passed: number; upperBps: number | null }[] = [];
  for (const kind of kinds) {
    const entry = byKind.get(kind);
    if (entry === undefined) continue;
    const label = labelOf(kind);
    for (const week of [...entry.weeks.keys()].sort()) {
      const counts = entry.weeks.get(week);
      if (counts === undefined) continue;
      const row: ReportRow = { actionType: label, weekStart: week };
      for (const key of COUNT_KEYS) row[key] = counts[key];
      row.missedBps = missedBpsOf(counts);
      rows.push(row);
    }
    const t = entry.total;
    const totals: Record<string, number> = {};
    for (const key of COUNT_KEYS) totals[key] = t[key];
    const missedBps = missedBpsOf(t);
    if (missedBps !== null) totals.missedBps = missedBps;
    subtotals.push({ label, totals });
    const upperBps = t.passed > 0 ? wilsonUpperBps(t.missed, t.passed) : null;
    trust.push({ kind, upperBps, ready: trustReady(t.passed, upperBps) });
    judged.push({ label, passed: t.passed, upperBps });
  }
  // The display-only sentence is always first, and an empty result keeps the definitions, so an
  // empty table never reads as a clean record.
  const notes = [
    DISPLAY_ONLY_NOTE,
    DEFINITION_NOTE,
    VERDICT_NOTE,
    ...(input.weekStartDow === null ? [MONDAY_NOTE] : []),
    ...verdictNotes(judged),
  ];
  const result = reportOf("trust_meter", {
    asOf,
    args: argsOf({ asOf }),
    period: { start: first, end: last },
    rows,
    subtotals,
    notes,
  });
  // A tool result loses rows from the end, so each action type's verdict also rides whole at the
  // top level, beside the subtotals, which a tool result never cuts.
  return { ...result, trust };
}
