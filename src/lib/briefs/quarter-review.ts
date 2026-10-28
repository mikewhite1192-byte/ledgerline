import type { Queryable } from "../db";
import { readTable } from "../data/read";
import type { BriefRow } from "../data/rows";
import { compareText, type BriefFigure, type Quarter } from "../rules-engine";
import { quarterContaining, type LocalDate } from "../time/local-date";
import { figuresText } from "./figures";
import { packFigures, readQuarter } from "./quarter-figures";
import { checkBriefText, type BriefCategory, type BriefVerification } from "./verify";
import { BRIEF_LEASE_MS, figuresOf } from "./view";

// The quarter review's shape, its number check, and what the /quarter page and the agent's read
// tool show. The review is four headed lists; every item in every list passes the same number
// check as the profit brief (verify.ts) against the figures stored with the review, and one item
// that fails refuses the whole review, which then keeps no words. Reads only.

export const QUARTER_SECTIONS = ["went_well", "problems", "recovered", "change"] as const;
export type QuarterSection = (typeof QUARTER_SECTIONS)[number];
export type QuarterBody = Record<QuarterSection, string[]>;

// How many items each list holds: the rules ask for these (write-quarter.ts) and the check holds
// the reply to them. The format's schema leaves counts out (outside the verified strict subset).
export const SECTION_ITEMS: Readonly<Record<QuarterSection, { min: number; max: number }>> = {
  went_well: { min: 1, max: 5 },
  problems: { min: 1, max: 5 },
  recovered: { min: 1, max: 4 },
  change: { min: 3, max: 3 },
};

// The four lists, each a list of strings of the right length, and nothing else; null otherwise.
export function quarterBodyOf(value: unknown): QuarterBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== QUARTER_SECTIONS.length || !QUARTER_SECTIONS.every((s) => keys.includes(s))) return null;
  const out: Partial<QuarterBody> = {};
  for (const s of QUARTER_SECTIONS) {
    const items = (value as Record<string, unknown>)[s];
    if (!Array.isArray(items) || items.length < SECTION_ITEMS[s].min || items.length > SECTION_ITEMS[s].max) {
      return null;
    }
    if (!items.every((i): i is string => typeof i === "string")) return null;
    out[s] = [...items];
  }
  return out as QuarterBody;
}

export function parseQuarterReply(reply: string): QuarterBody | null {
  try {
    return quarterBodyOf(JSON.parse(reply));
  } catch {
    return null;
  }
}

export type QuarterCheck =
  | { ok: true; body: QuarterBody; verification: BriefVerification }
  | { ok: false; category: BriefCategory; verification: BriefVerification };

// Every item, in order, through the brief's number check. The record joins the tags cited and the
// numbers read across the items checked; the first item that fails refuses the review.
export function verifyQuarter(reply: string, figures: readonly BriefFigure[]): QuarterCheck {
  const body = parseQuarterReply(reply);
  if (body === null) return { ok: false, category: "format", verification: { category: "format", cited: [], numbers: 0 } };
  const cited = new Set<string>();
  let numbers = 0;
  const record = (category: BriefCategory | null): BriefVerification => ({
    category,
    cited: [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    numbers,
  });
  const out: Partial<QuarterBody> = {};
  for (const s of QUARTER_SECTIONS) {
    const kept: string[] = [];
    for (const item of body[s]) {
      const checked = checkBriefText(item, figures);
      for (const key of checked.verification.cited) cited.add(key);
      numbers += checked.verification.numbers;
      if (!checked.ok) return { ok: false, category: checked.category, verification: record(checked.category) };
      kept.push(checked.text);
    }
    out[s] = kept;
  }
  return { ok: true, body: out as QuarterBody, verification: record(null) };
}

export type QuarterRecord = {
  id: string;
  status: BriefRow["status"];
  quarterStart: LocalDate;
  quarterEnd: LocalDate;
  // The carrier's date the review was asked for: the figures run to this day.
  asOf: LocalDate;
  // Empty when a drafted row's stored figures no longer read back (its body is then null too).
  figures: BriefFigure[];
  // The checked lists, with their [fN] tags; null unless drafted and readable.
  body: QuarterBody | null;
  category: string | null;
  updatedAt: string;
};

// A row whose figures do not read back is left out, except a drafted one: that row still holds
// its quarter (it is final), so it is kept with no figures and no body and reads as unreadable.
function recordOf(row: BriefRow): QuarterRecord | null {
  const figures = figuresOf(row.figures);
  if (figures === null && row.status !== "drafted") return null;
  const body = row.status === "drafted" && figures !== null ? quarterBodyOf(row.body) : null;
  return {
    id: row.id,
    status: row.status,
    quarterStart: row.period_start,
    quarterEnd: row.period_end,
    asOf: row.as_of,
    figures: figures ?? [],
    body,
    category: row.refusal_category,
    updatedAt: row.updated_at,
  };
}

// The carrier's reviews of one quarter, newest first.
export async function readQuarterReviews(q: Queryable, quarterStart: LocalDate): Promise<QuarterRecord[]> {
  const rows = await readTable(q, "briefs");
  return rows
    .filter((r) => r.kind === "quarter" && r.period_start === quarterStart)
    .sort((a, b) => compareText(b.updated_at, a.updated_at) || compareText(b.id, a.id))
    .flatMap((r) => {
      const record = recordOf(r);
      return record ? [record] : [];
    });
}

export type QuarterState =
  // Nothing written yet: the button is offered.
  | { kind: "none" }
  // A request is out right now; the page offers nothing until it ends.
  | { kind: "writing" }
  // The last try did not pass (or never went out); "Write again" is offered.
  | { kind: "refused"; category: string }
  // Passed the check. `changed` when the figures moved after it was written: it keeps its own.
  | { kind: "drafted"; review: QuarterRecord; changed: boolean }
  // A drafted review whose stored lists or figures no longer read back. It still holds the quarter,
  // so a new press would only be told it exists: nothing is offered.
  | { kind: "unreadable" };

export function quarterStateOf(reviews: readonly QuarterRecord[], live: readonly BriefFigure[], now: Date): QuarterState {
  const drafted = reviews.find((r) => r.status === "drafted");
  if (drafted) {
    if (drafted.body === null) return { kind: "unreadable" };
    return { kind: "drafted", review: drafted, changed: figuresText(drafted.figures) !== figuresText(live) };
  }
  const latest = reviews.find((r) => r.status !== "superseded");
  if (!latest) return { kind: "none" };
  if (latest.status === "drafting") {
    // Past its lease it was cut off; the next press marks it and writes again.
    const age = now.getTime() - Date.parse(latest.updatedAt);
    return age < BRIEF_LEASE_MS ? { kind: "writing" } : { kind: "refused", category: "interrupted" };
  }
  return { kind: "refused", category: latest.category ?? "error" };
}

// Something to write about: a pay run, a delivered load, an invoice or a payment so far.
export function hasActivity(q: Quarter): boolean {
  return q.pay.runs > 0 || q.margin.loadsDelivered > 0 || q.invoiced.count > 0 || q.received.count > 0;
}

export type QuarterView = {
  quarter: Quarter;
  // The figures the review is written from (the top of the list that fits the prompt).
  packed: BriefFigure[];
  review: QuarterState;
};

// The calendar quarter holding today, so far, and its review, if any.
export async function readQuarterView(
  q: Queryable,
  today: LocalDate,
  timezone: string,
  maxInputChars: number,
  now: Date,
): Promise<QuarterView> {
  const period = quarterContaining(today);
  const quarter = await readQuarter(q, period, today, timezone);
  const packed = packFigures(quarter.figures, maxInputChars);
  const review = quarterStateOf(await readQuarterReviews(q, period.start), packed, now);
  return { quarter, packed, review };
}
