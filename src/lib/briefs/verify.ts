import { hasOtherDigit, HIDDEN, LINK, moneyFigures, normalizeNumber } from "../driver-notes/verify";
import type { BriefFigure } from "../rules-engine";

// The check every brief passes before anyone reads it. Pure: no database, clock or model. The
// model is given a numbered list of figures the rules engine computed and must write the tag
// ([f7]) right after every number it uses. Here every number in the words is read back and held
// to the figure its tag names, by whole value: money to the cent, a percent to the basis point, a
// count exactly. A number with no tag right after it, a tag the list does not have, or a number
// that is not its figure's value refuses the whole brief. So the words can only repeat figures
// the engine emitted; a sum, a difference or a rounding the model made itself never passes.
//
// Words for numbers ("two routes", "half", "percent") are refused too, so a count the model made
// up cannot slip past the digit scan. The names a figure is about (a route, a customer) are read
// as names, never as numbers. A brief that fails keeps no text: the caller stores the category and
// the counts below.

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
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|twice|double|triple|percent)\b/i;
const MINUS = /[-−]$/;
const LOSS_WORDS = /\b(?:loss|losses|lost|losing|negative|minus)\b/i;

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
  if (HIDDEN.test(text) || LINK.test(text) || hasOtherDigit(text)) return fail("format");

  const byKey = new Map(figures.map((f) => [f.key, f]));
  const tags = readTags(text, new Set(byKey.keys()));
  if (typeof tags === "string") return fail(tags);
  for (const t of tags) cited.add(t.key);
  if (tags.length === 0) return fail("format");

  // Tags and the names figures are about come out before the numbers are read, so "[f12]" is a
  // tag and a customer called "Route 9 Foods" is a name. Positions stay where they were.
  let masked = text;
  for (const t of tags) masked = blank(masked, t.start, t.end);
  if (/[[\]]/.test(masked)) return fail("format");
  const subjects = [...new Set(figures.flatMap((f) => (f.subject ? [f.subject] : [])))].sort(
    (a, b) => b.length - a.length,
  );
  for (const subject of subjects) {
    for (let at = masked.indexOf(subject); at !== -1; at = masked.indexOf(subject, at + subject.length)) {
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
    // The sign: a figure below zero is written with a minus or as a loss; one above zero never
    // carries a minus.
    const before = text.slice(0, start);
    const minus = MINUS.test(before);
    if (figure.value < 0 && !minus && !LOSS_WORDS.test(before.slice(-40))) return fail("number_mismatch");
    if (figure.value >= 0 && minus) return fail("number_mismatch");
    spans.push({ start: minus ? start - 1 : start, numberEnd: end, tagStart: tag.start, end: tag.end, key: tag.key });
  }
  return { ok: true, text, spans, tags, verification: record(null) };
}
