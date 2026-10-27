import type { Queryable } from "../db";
import {
  countOpenBreaks,
  readBreak,
  readBreaks,
  readLatestRun,
  type BreakView,
  type RunView,
} from "../data/card-recon";
import { formatLocalDate } from "../format/dates";
import { categoryWords, DISMISS_WORDS, FIX_WORDS, fixedSentence, lineWords, money, recordWords, RECORD_WORDS } from "./words";

// What the card check's pages read and how they say it: the newest check, the open differences
// (most serious first), and the counters. Every sentence is built here from fixed words and the
// stored cents; a model's sentence shows only when the run kept it (its figures checked).

export const HOME_BREAKS = 50;

export type CardHome = {
  run: RunView | null;
  breaks: BreakView[];
  open: { needsYou: number; notConfirmed: number };
};

export async function readCardHome(q: Queryable): Promise<CardHome> {
  const run = await readLatestRun(q);
  const breaks = await readBreaks(q, "open", HOME_BREAKS);
  const open = await countOpenBreaks(q);
  return { run, breaks, open };
}

export async function readCardBreak(q: Queryable, id: string): Promise<BreakView | null> {
  return readBreak(q, id);
}

// A whole count from the run's stored counts, or 0 when it is missing or not a whole number.
export function countOf(run: RunView | null, key: string): number {
  const v = run?.counts[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// "Checked 38 card transactions and 6 payment records. 4 need you."
export function resultLine(run: RunView): string {
  if (run.status === "running") return "A check is running now.";
  if (run.status === "failed") return "The last check stopped before it finished. Press Check cards to run it again.";
  const needs = countOf(run, "needsYou");
  const head = `Checked ${plural(countOf(run, "statement"), "card transaction", "card transactions")} and ${plural(countOf(run, "records"), "payment record", "payment records")}.`;
  const tail = needs === 0 ? "Nothing needs you." : `${plural(needs, "needs", "need")} you.`;
  return `${head} ${tail}`;
}

// The lines for the systems the check could not read in full, each once.
export function uncheckedLines(run: RunView | null): string[] {
  if (!run) return [];
  const out: string[] = [];
  for (const raw of run.unchecked) {
    if (!raw || typeof raw !== "object") continue;
    const { system, category } = raw as Record<string, unknown>;
    if (typeof system !== "string" || typeof category !== "string") continue;
    const line = lineWords({ system, category });
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function day(value: string): string {
  try {
    return formatLocalDate(value);
  } catch {
    return "an unknown day";
  }
}

// What a difference is about, in one line: "Fuel $212.40 on card ending 4417, Oct 30, 2026, OK".
export function whatLine(b: BreakView): string {
  const t = b.transaction;
  if (t) {
    const what = t.kind === "load" ? "Card load" : "Fuel";
    const where = t.state ? `, ${t.state}` : "";
    return `${what} ${money(t.amountCents)} on card ending ${t.last4}, ${day(t.postedOn)}${where}`;
  }
  if (b.record && Object.hasOwn(RECORD_WORDS, b.record.kind)) {
    const words = RECORD_WORDS[b.record.kind];
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  }
  return "A payment record";
}

// The sentence a difference shows: the run's checked sentence, else the fixed one.
export function breakSentence(b: BreakView): string {
  if (b.explanation && b.explanation.trim().length > 0) return b.explanation;
  return fixedSentence({
    category: b.category,
    record: recordWords(b),
    ourCents: b.ourCents,
    outsideCents: b.outsideCents,
  });
}

export function breakTitle(b: BreakView): string {
  return categoryWords(b.category);
}

// A pill's words and tone: red only for what needs attention soon, amber for a person, blue for a
// later read, green for done, gray for closed.
export type Pill = { label: string; tone: "neutral" | "info" | "success" | "warning" | "destructive" };

const SEVERITY: Readonly<Record<string, Pill>> = {
  high: { label: "High", tone: "destructive" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
};

export function severityOf(b: Pick<BreakView, "severity">): Pill {
  return Object.hasOwn(SEVERITY, b.severity) ? SEVERITY[b.severity] : SEVERITY.low;
}

// What a difference waits for: a match to approve, a later read, or a person by hand. A match
// the engine could not propose (no single driver) is by hand.
export function fixOf(b: Pick<BreakView, "fixKind" | "proposalId">): string {
  if (b.fixKind === "card_match" && !b.proposalId) return FIX_WORDS.by_hand;
  return Object.hasOwn(FIX_WORDS, b.fixKind) ? FIX_WORDS[b.fixKind] : FIX_WORDS.by_hand;
}

export function statusOf(b: Pick<BreakView, "status" | "fixKind" | "dismissCategory">): Pill {
  if (b.status === "resolved") return { label: "Fixed", tone: "success" };
  if (b.status === "dismissed") {
    const why = b.dismissCategory && Object.hasOwn(DISMISS_WORDS, b.dismissCategory) ? DISMISS_WORDS[b.dismissCategory] : "Other";
    return { label: `Dismissed: ${why}`, tone: "neutral" };
  }
  if (b.fixKind === "check_pending") return { label: "Not confirmed yet", tone: "info" };
  return { label: "Needs you", tone: "warning" };
}

// "112.400" gallons from thousandths, whole-number math.
export function gallons(milli: number | null): string | null {
  if (milli === null || !Number.isSafeInteger(milli) || milli < 0) return null;
  return `${Math.trunc(milli / 1000).toLocaleString("en-US")}.${String(milli % 1000).padStart(3, "0")}`;
}

export function dayWords(value: string): string {
  return day(value);
}
