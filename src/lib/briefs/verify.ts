import { HIDDEN, LINK, moneyFigures, normalizeNumber } from "../driver-notes/verify";
import type { BriefFigure } from "../rules-engine";

// The check every brief passes before anyone reads it. Pure: no database, clock or model. The
// model is given a numbered list of figures the rules engine computed and must write the tag
// ([f7]) right after every number it uses. Here every number in the words is read back and held
// to the figure its tag names, by whole value: money to the cent, a percent to the basis point, a
// count exactly. A number with no tag right after it, a tag the list does not have, or a number
// that is not its figure's value refuses the whole brief. So the words can only repeat figures
// the engine emitted; a sum, a difference or a rounding the model made itself never passes.
//
// Words for numbers ("one route", "zero customers", "a quarter of loads", "half", "percent") are
// refused too, and so is any number character but ASCII 0-9 (a fraction like ½, a superscript like
// ², a digit of another script), so a count the model made up cannot slip past the digit scan. A
// figure with a letter or a size right after it ("$48k", "$1.2 M") is refused, not read short. The
// names a figure is about (a route, a customer) are read as names, never as numbers; a name that
// itself holds a number refuses the brief when the words use it, since that number would go
// unchecked. A figure below zero needs its own minus sign, or a loss word in its own clause. A
// brief that fails keeps no text: the caller stores the category and the counts below.

export const BRIEF_CATEGORIES = ["format", "unknown_tag", "number_mismatch", "untagged"] as const;
export type BriefCategory = (typeof BRIEF_CATEGORIES)[number];

export const MAX_BRIEF_CHARS = 1500;
// A number's tag must start within this many characters after it ("$48,210.00 [f1]").
export const TAG_REACH = 12;

// Stored as jsonb on the brief: the category, the tags cited and how many numbers were read.
export type BriefVerification = {
  category: BriefCategory | null;
  cited: string[];
  numbers: number;
};

// One tagged number in the text: [start, end) covers the number (with its % sign) and its tag.
export type TaggedSpan = { start: number; numberEnd: number; tagStart: number; end: number; key: string };

export type BriefCheck =
  | { ok: true; text: string; spans: TaggedSpan[]; tags: Tag[]; verification: BriefVerification }
  | { ok: false; category: BriefCategory; verification: BriefVerification };

export type Tag = { start: number; end: number; key: string };

// The exact shape the format asks for: {"text": "..."} and nothing else.
export function parseBriefReply(reply: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "text") return null;
  const text = (value as { text: unknown }).text;
  return typeof text === "string" ? text : null;
}

const BRACKET = /\[([^[\]]{0,40})\]/g;
const TAG = /^f([1-9][0-9]{0,3})$/;
// Number words, whole words in any case. A word list cannot be complete ("no customers", "all
// routes" still read as words); these are the ones that name a number outright.
const NUMBER_WORDS = new RegExp(
  `\\b(?:${[
    // Counts.
    "zero|nil|nought|naught|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve",
    "thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen",
    "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety",
    "ones|twos|threes|fours|fives|sixes|sevens|eights|nines|tens|twenties|thirties|forties|fifties",
    "hundreds?|thousands?|millions?|billions?|trillions?",
    // Places and parts.
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth",
    "thirds|fourths|fifths|sixths|sevenths|eighths|ninths|tenths",
    "twentieth|thirtieth|fortieth|fiftieth|hundredth|thousandth",
    "half|halves|quarters?",
    // Times, groups and rates.
    "once|twice|thrice|single|double|triple|quadruple|dozens?|pairs?|couple",
    "percent|percentage|pct|per\\s+cent|bps|basis\\s+points?",
  ].join("|")})\\b`,
  "i",
);
// Right after a figure: a letter ("$48k", "12th") or, after a space, a size ("$48 K", "$2 mil").
const AFTER_FIGURE = /^(?:\p{L}|\s*(?:k|m|mm|mn|b|bn|mil|grand)\b)/iu;
// The figure scan reads ASCII digits only, so any other number character (a digit of another
// script, a fraction like ½, a superscript like ², a numeral like Ⅳ) is refused before it.
const OTHER_NUMBER = /\p{N}/u;
const MINUS = /[-−]$/;
const LOSS_WORDS = /\b(?:loss|losses|lost|losing|negative|minus)\b/i;
// A loss word counts only in the figure's own clause: after the tag before it, after the end of
// the sentence or clause it follows, and at most this many characters back.
const LOSS_REACH = 40;
const CLAUSE_END = /[.!?;]\s|\n/g;

function hasOtherNumber(text: string): boolean {
  return OTHER_NUMBER.test(text.replace(/[0-9]/g, ""));
}

// The words a figure starting at `start` shares a clause with, before it: from the end of the
// tag before it or the clause before it, whichever is nearer, at most LOSS_REACH back.
function ownClause(masked: string, start: number, tags: readonly Tag[]): string {
  let from = Math.max(0, start - LOSS_REACH);
  for (const t of tags) if (t.end <= start && t.end > from) from = t.end;
  const window = masked.slice(from, start);
  let cut = 0;
  for (const m of window.matchAll(CLAUSE_END)) cut = (m.index ?? 0) + m[0].length;
  return window.slice(cut);
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

// The tags in the text, in order, or the category that refuses it.
function readTags(text: string, keys: ReadonlySet<string>): Tag[] | BriefCategory {
  const tags: Tag[] = [];
  for (const m of text.matchAll(BRACKET)) {
    const tag = TAG.exec(m[1]);
    if (!tag) return "unknown_tag";
    const key = `f${tag[1]}`;
    if (!keys.has(key)) return "unknown_tag";
    const start = m.index ?? 0;
    tags.push({ start, end: start + m[0].length, key });
  }
  return tags;
}

// A percent as written ("37.56", "5") in basis points; null for more than two decimals.
function percentBps(digits: string): number | null {
  const [whole, fraction = ""] = digits.split(".");
  if (fraction.length > 2) return null;
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
  return Number.isSafeInteger(bps) ? bps : null;
}

// The model's reply, parsed and checked.
export function verifyBrief(reply: string, figures: readonly BriefFigure[]): BriefCheck {
  const parsed = parseBriefReply(reply);
  if (parsed === null) return { ok: false, category: "format", verification: { category: "format", cited: [], numbers: 0 } };
  return checkBriefText(parsed, figures);
}

// The words alone, checked: what verifyBrief runs after parsing, and what the page runs again on a
// stored brief to find where each tagged number sits.
export function checkBriefText(words: string, figures: readonly BriefFigure[]): BriefCheck {
  const cited = new Set<string>();
  let numbers = 0;
  const record = (category: BriefCategory | null): BriefVerification => ({
    category,
    cited: [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    numbers,
  });
  const fail = (category: BriefCategory): BriefCheck => ({ ok: false, category, verification: record(category) });

  const text = words.trim();
  if (text.length === 0 || text.length > MAX_BRIEF_CHARS) return fail("format");
  if (HIDDEN.test(text) || LINK.test(text) || hasOtherNumber(text)) return fail("format");

  const byKey = new Map(figures.map((f) => [f.key, f]));
  const tags = readTags(text, new Set(byKey.keys()));
  if (typeof tags === "string") return fail(tags);
  for (const t of tags) cited.add(t.key);
  if (tags.length === 0) return fail("format");

  // Tags and the names figures are about come out before the numbers are read, so "[f12]" is a
  // tag and a customer called "Second Street Foods" is a name. Positions stay where they were.
  let masked = text;
  for (const t of tags) masked = blank(masked, t.start, t.end);
  if (/[[\]]/.test(masked)) return fail("format");
  const subjects = [...new Set(figures.flatMap((f) => (f.subject ? [f.subject] : [])))].sort(
    (a, b) => b.length - a.length,
  );
  for (const subject of subjects) {
    let at = masked.indexOf(subject);
    if (at === -1) continue;
    // A name that holds a number ("Route 9 Foods") would hide that number from the scan below, so
    // the words may not use it: refused, never blanked.
    if (moneyFigures(subject).length > 0) return fail("untagged");
    for (; at !== -1; at = masked.indexOf(subject, at + subject.length)) {
      masked = blank(masked, at, at + subject.length);
    }
  }
  if (NUMBER_WORDS.test(masked)) return fail("untagged");

  const found = moneyFigures(masked);
  numbers = found.length;
  const spans: TaggedSpan[] = [];
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const lead = masked.slice(f.start, f.end).search(/\S/);
    const start = f.start + Math.max(lead, 0);
    let end = f.end;
    const percent = /^\s?%/.exec(masked.slice(end));
    if (percent) end += percent[0].length;
    // "$48k" is not $48.00: a figure with a letter or a size after it is not the figure written.
    if (AFTER_FIGURE.test(text.slice(end))) return fail("number_mismatch");
    // The tag right after this number: within reach, and before the next number starts.
    const next = i + 1 < found.length ? found[i + 1].start : Number.POSITIVE_INFINITY;
    const tag = tags.find((t) => t.start >= end && t.start - end <= TAG_REACH && t.start < next);
    if (!tag || f.kind === "unreadable") return fail(f.kind === "unreadable" ? "number_mismatch" : "untagged");
    const figure = byKey.get(tag.key);
    if (figure === undefined || typeof figure.value !== "number") return fail("number_mismatch");
    const size = Math.abs(figure.value);
    let same: boolean;
    if (percent) {
      same = figure.kind === "bps" && percentBps(f.digits) === size;
    } else if (f.kind === "cents") {
      same = figure.kind === "cents" && f.cents === size;
    } else {
      same = figure.kind === "int" && f.number === normalizeNumber(String(size));
    }
    if (!same) return fail("number_mismatch");
    // The sign: a figure below zero is written with a minus right before it, or with a loss word
    // in its own clause (never one that belongs to the figure before it, never a name); one above
    // zero never carries a minus.
    const minus = MINUS.test(text.slice(0, start));
    if (figure.value < 0 && !minus && !LOSS_WORDS.test(ownClause(masked, start, tags))) return fail("number_mismatch");
    if (figure.value >= 0 && minus) return fail("number_mismatch");
    spans.push({ start: minus ? start - 1 : start, numberEnd: end, tagStart: tag.start, end: tag.end, key: tag.key });
  }
  return { ok: true, text, spans, tags, verification: record(null) };
}
