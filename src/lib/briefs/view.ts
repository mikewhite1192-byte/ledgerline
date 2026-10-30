import type { Queryable } from "../db";
import { readTable } from "../data/read";
import type { BriefRow } from "../data/rows";
import {
  compareText,
  FIGURE_KINDS,
  FIGURE_SECTIONS,
  type BriefFigure,
  type FigureSection,
  type FigureSource,
} from "../rules-engine";
import { isLocalDate, type LocalDate } from "../time/local-date";
import { closedWeeks, figuresText, profitWeek, readProfitInput, type ClosedWeek, type ProfitWeek } from "./figures";

// What the /profit page and the agent's read tool show for one closed week: the engine's figures,
// read live, and the brief written for it, if any. Reads only.

// A brief left drafting longer than this was cut off mid-call (the route runs at most 30 s): the
// page stops showing it as being written, and the next press marks it refused (interrupted).
export const BRIEF_LEASE_MS = 10 * 60_000;

export type BriefRecord = {
  id: string;
  status: BriefRow["status"];
  periodStart: LocalDate;
  periodEnd: LocalDate;
  // The carrier's date the brief was asked for.
  asOf: LocalDate;
  figures: BriefFigure[];
  // The checked words, with their [fN] tags; null unless drafted.
  text: string | null;
  category: string | null;
  updatedAt: string;
};

function sourceOf(raw: unknown): FigureSource | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if ((s.table === "customers" || s.table === "drivers") && typeof s.id === "string") {
    return { table: s.table, id: s.id };
  }
  if (typeof s.section === "string" && (FIGURE_SECTIONS as readonly string[]).includes(s.section)) {
    return { section: s.section as FigureSection };
  }
  if (typeof s.args !== "object" || s.args === null) return null;
  const args = s.args as Record<string, unknown>;
  if (s.report === "margin_per_load" && isLocalDate(args.periodStart) && isLocalDate(args.periodEnd)) {
    return { report: "margin_per_load", args: { periodStart: args.periodStart, periodEnd: args.periodEnd } };
  }
  if (s.report === "ar_aging" && isLocalDate(args.asOf)) {
    return { report: "ar_aging", args: { asOf: args.asOf } };
  }
  return null;
}

// The stored figures, read back whole; null when any one is not the shape the engine writes.
export function figuresOf(raw: readonly unknown[]): BriefFigure[] | null {
  const out: BriefFigure[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const f = item as Record<string, unknown>;
    const source = sourceOf(f.source);
    if (
      typeof f.key !== "string" ||
      typeof f.label !== "string" ||
      typeof f.kind !== "string" ||
      !(FIGURE_KINDS as readonly string[]).includes(f.kind) ||
      !(typeof f.value === "string" || Number.isSafeInteger(f.value)) ||
      (f.subject !== undefined && typeof f.subject !== "string") ||
      source === null
    ) {
      return null;
    }
    out.push({
      key: f.key,
      label: f.label,
      kind: f.kind as BriefFigure["kind"],
      value: f.value as number | string,
      source,
      ...(typeof f.subject === "string" ? { subject: f.subject } : {}),
    });
  }
  return out;
}

function recordOf(row: BriefRow): BriefRecord | null {
  const figures = figuresOf(row.figures);
  if (figures === null) return null;
  const text = row.status === "drafted" && typeof row.body?.text === "string" ? row.body.text : null;
  return {
    id: row.id,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    asOf: row.as_of,
    figures,
    text,
    category: row.refusal_category,
    updatedAt: row.updated_at,
  };
}

// The carrier's profit briefs for one week, newest first.
export async function readProfitBriefs(q: Queryable, periodStart: LocalDate): Promise<BriefRecord[]> {
  const rows = await readTable(q, "briefs");
  return rows
    .filter((r) => r.kind === "profit_week" && r.period_start === periodStart)
    .sort((a, b) => compareText(b.updated_at, a.updated_at) || compareText(b.id, a.id))
    .flatMap((r) => {
      const record = recordOf(r);
      return record ? [record] : [];
    });
}

export type BriefState =
  // Nothing written yet: the button is offered.
  | { kind: "none" }
  // A request is out right now; the page offers nothing until it ends.
  | { kind: "writing" }
  // The last try did not pass (or never went out); "Write again" is offered.
  | { kind: "refused"; category: string }
  // Passed the check. `changed` when the week's figures moved after it was written.
  | { kind: "drafted"; brief: BriefRecord; changed: boolean };

export function briefStateOf(briefs: readonly BriefRecord[], live: readonly BriefFigure[], now: Date): BriefState {
  const drafted = briefs.find((b) => b.status === "drafted" && b.text !== null);
  if (drafted) {
    return { kind: "drafted", brief: drafted, changed: figuresText(drafted.figures) !== figuresText(live) };
  }
  const latest = briefs.find((b) => b.status !== "superseded");
  if (!latest) return { kind: "none" };
  if (latest.status === "drafting") {
    // Past its lease it was cut off; the next press marks it and writes again.
    const age = now.getTime() - Date.parse(latest.updatedAt);
    return age < BRIEF_LEASE_MS ? { kind: "writing" } : { kind: "refused", category: "interrupted" };
  }
  return { kind: "refused", category: latest.category ?? "error" };
}

export type ProfitView = {
  weeks: ClosedWeek[];
  week: ClosedWeek | null;
  profit: ProfitWeek | null;
  brief: BriefState;
};

// The week asked for when it is one of the closed weeks offered, else the newest closed week.
export async function readProfitView(
  q: Queryable,
  today: LocalDate,
  asked: string | null,
  limits: { maxLanes: number; maxCustomers: number },
  now: Date,
): Promise<ProfitView> {
  const weeks = await closedWeeks(q, today);
  const week = weeks.find((w) => w.start === asked) ?? weeks[0] ?? null;
  if (!week) return { weeks, week: null, profit: null, brief: { kind: "none" } };
  const period = { start: week.start, end: week.end };
  const profit = profitWeek(await readProfitInput(q, period), period, limits);
  const brief = briefStateOf(await readProfitBriefs(q, week.start), profit.figures, now);
  return { weeks, week, profit, brief };
}
