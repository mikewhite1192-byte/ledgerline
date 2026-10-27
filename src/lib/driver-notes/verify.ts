// The check every drafted note passes before a person sees it. Pure: no database, no clock, no
// model. The model's reply must parse exactly; every number in the body must come from the
// paystub pack; every line it cites must be on the paystub; the language must be the driver's.
// A note that fails is never shown as approvable: the caller stores the category and the amounts
// compared, never the text.
//
// What counts as a number: every run of digits in the body outside a line citation. A figure
// marked as money ($1,234.56, 1,234.56 dollars, USD 12) is parsed to cents and must equal an
// amount on the pack (sign ignored: "a $120.00 deduction" is the -12000 line). A bare figure with
// exactly two decimals is read as dollars the same way. Any other bare figure (miles, days, a
// date, a load number, a percent) must be one of the pack's own numbers. A figure in any other
// shape (1.234,56, 1,23) cannot be read with certainty and is refused. The limit: a number spelled
// out in words ("three loads") is not checked; the prompt asks for digits.

export type NoteLanguage = "en" | "es";
export type ModelLanguage = "English" | "Spanish";

export const MODEL_LANGUAGE: Record<NoteLanguage, ModelLanguage> = { en: "English", es: "Spanish" };

export const VERIFY_CATEGORIES = ["format", "language", "line_mismatch", "number_mismatch"] as const;
export type VerifyCategory = (typeof VERIFY_CATEGORIES)[number];

export const MAX_BODY_CHARS = 1200;

// What the check compares against, built by pack.ts from stored rows only.
export type NoteCheck = {
  language: NoteLanguage;
  // Every amount on the pack, in cents, as absolute values.
  allowedCents: readonly number[];
  // Every other number on the pack, normalized ("72.5", "1042", "2026").
  allowedNumbers: readonly string[];
  // The paystub's line numbers.
  seqs: readonly number[];
};

export type NoteReply = { language: ModelLanguage; body: string; cited_seqs: number[] };

// Stored as jsonb on the note: cents and normalized numbers only, never text.
export type Verification = {
  allowed: number[];
  found: number[];
  numbers: string[];
  category: VerifyCategory | null;
};

export type VerifyResult =
  | { ok: true; body: string; citedSeqs: number[]; verification: Verification }
  | { ok: false; category: VerifyCategory; verification: Verification };

const REPLY_KEYS = ["body", "cited_seqs", "language"];

// The exact shape the format below asks for: no other key, no other type.
export function parseReply(text: string): NoteReply | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== REPLY_KEYS.length || keys.some((k, i) => k !== REPLY_KEYS[i])) return null;
  const v = value as Record<string, unknown>;
  if (v.language !== "English" && v.language !== "Spanish") return null;
  if (typeof v.body !== "string") return null;
  if (!Array.isArray(v.cited_seqs) || v.cited_seqs.length > 100) return null;
  if (!v.cited_seqs.every((n) => typeof n === "number" && Number.isSafeInteger(n))) return null;
  return { language: v.language, body: v.body, cited_seqs: v.cited_seqs as number[] };
}

// Control characters (a line break is allowed), bidirectional overrides and zero-width marks
// could hide text from the person approving the note.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const LINK = /https?:|www\.|:\/\//i;
const SENTENCE = /[A-Za-zÁÉÍÓÚÑÜáéíóúñü][\s\S]*[.!?]/;

// A citation: [line 3], [lines 3 and 4], [línea 3], [líneas 3, 4 y 5].
const BRACKET = /\[([^\][]{1,60})\]/g;
const LINE_WORD = /^\s*(?:lines?|l[íi]neas?)(?=[\s\d])/i;

// A figure with what may mark it as money before or after it.
const FIGURE =
  /(US\$|\$|USD\s?)?\s?(\d(?:[\d.,]*\d)?)(\s*(?:dollars?\b|d[óo]lares\b|USD\b|cents?\b|centavos\b))?/gi;
const US_GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN = /^\d+(?:\.\d+)?$/;
const MAX_DIGITS = 12;

// "072.50" reads "72.5"; "0" stays "0". Input is digits with at most one dot.
export function normalizeNumber(digits: string): string {
  const [whole, fraction = ""] = digits.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

// Dollars to cents from digits with at most one dot and at most two decimals; null otherwise.
function dollarsToCents(digits: string): number | null {
  const [whole, fraction = ""] = digits.split(".");
  if (fraction.length !== 0 && fraction.length !== 2) return null;
  const cents = Number(whole) * 100 + (fraction ? Number(fraction) : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

type Scan = { cents: number[]; numbers: string[]; unreadable: boolean };

function scanFigures(text: string): Scan {
  const out: Scan = { cents: [], numbers: [], unreadable: false };
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[2];
    const before = (m[1] ?? "").trim().toUpperCase();
    const after = (m[3] ?? "").trim().toLowerCase();
    let digits: string;
    if (US_GROUPED.test(raw)) digits = raw.replace(/,/g, "");
    else if (PLAIN.test(raw)) digits = raw;
    else {
      out.unreadable = true;
      continue;
    }
    if (digits.replace(".", "").length > MAX_DIGITS) {
      out.unreadable = true;
      continue;
    }
    const isCents = after.startsWith("cent");
    const isDollars = before !== "" || (after !== "" && !isCents);
    if (isCents) {
      if (digits.includes(".")) {
        out.unreadable = true;
        continue;
      }
      out.cents.push(Number(digits));
    } else if (isDollars) {
      const cents = dollarsToCents(digits);
      if (cents === null) out.unreadable = true;
      else out.cents.push(cents);
    } else if (/\.\d{2}$/.test(digits)) {
      // A bare figure with two decimals is an amount written without its dollar sign.
      const cents = dollarsToCents(digits);
      if (cents === null) out.unreadable = true;
      else out.cents.push(cents);
    } else {
      out.numbers.push(normalizeNumber(digits));
    }
  }
  return out;
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function verifyNote(text: string, check: NoteCheck): VerifyResult {
  const allowed = sortedUnique(check.allowedCents.map((c) => Math.abs(c)));
  const record = (category: VerifyCategory | null, found: number[] = [], numbers: string[] = []) => ({
    allowed,
    found: sortedUnique(found),
    numbers: [...new Set(numbers)].sort(),
    category,
  });
  const fail = (category: VerifyCategory, found?: number[], numbers?: string[]): VerifyResult => ({
    ok: false,
    category,
    verification: record(category, found, numbers),
  });

  const reply = parseReply(text);
  if (!reply) return fail("format");
  const body = reply.body.trim();
  if (body.length === 0 || body.length > MAX_BODY_CHARS) return fail("format");
  if (HIDDEN.test(body) || LINK.test(body) || !SENTENCE.test(body)) return fail("format");

  if (reply.language !== MODEL_LANGUAGE[check.language]) return fail("language");

  // Citations come out of the text before the numbers are read, so "[line 3]" is a line, not a 3.
  const seqs = new Set(check.seqs);
  const cited: number[] = [];
  let rest = body;
  for (const m of body.matchAll(BRACKET)) {
    if (!LINE_WORD.test(m[1])) continue;
    const inner = m[1].replace(LINE_WORD, "");
    if (!/^[\s\d,]*(?:(?:and|y)[\s\d,]*)*$/i.test(inner)) return fail("line_mismatch");
    const numbers = inner.match(/\d+/g) ?? [];
    if (numbers.length === 0) return fail("line_mismatch");
    for (const n of numbers) cited.push(Number(n));
    rest = rest.replace(m[0], " ");
  }
  for (const n of [...cited, ...reply.cited_seqs]) {
    if (!seqs.has(n)) return fail("line_mismatch");
  }

  const scan = scanFigures(rest);
  if (scan.unreadable) return fail("number_mismatch", scan.cents, scan.numbers);
  const allowedCents = new Set(allowed);
  const allowedNumbers = new Set(check.allowedNumbers);
  if (scan.cents.some((c) => !allowedCents.has(c)) || scan.numbers.some((n) => !allowedNumbers.has(n))) {
    return fail("number_mismatch", scan.cents, scan.numbers);
  }

  return {
    ok: true,
    body,
    citedSeqs: sortedUnique([...cited, ...reply.cited_seqs]),
    verification: record(null, scan.cents, scan.numbers),
  };
}
