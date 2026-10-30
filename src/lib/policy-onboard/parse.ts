import { isLocalDate, type LocalDate } from "../time/local-date";
import { parseValue, RuleError, RULES, type RuleKey, type RuleValue } from "../pay-rules/rules";

// The one reader of numbers in a pay policy's words: dollars to cents, percentages to basis
// points, weekdays, dates, minutes and the two enum rules. Code reads every value out of the
// document's own quote; the model's reading is only ever compared with it (cite.ts). Integers
// only; no floating point touches a figure. Pure.

// Whitespace collapsed and typographic quotes, dashes and spaces made plain, case kept. A quote is
// compared with its section in this form.
export function normalize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AmountTag = "day" | "week" | null;
export type Amount = { cents: number; tag: AmountTag; at: number; end: number };

// "$1,050", "$10.50", "$0.62", "125 dollars". Two decimals at most; "$10.5" is ten fifty.
const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?(?!\d)|\b(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?\s+dollars\b/gi;

// The words just after an amount that say what it is counted by: "per day", "for each calendar
// day", "daily"; "per week", "from each weekly settlement", "per settlement", "weekly".
const DAY_TAG = /^,?\s*(?:(?:[a-z]+\s+){0,2}?(?:per|a|each|every)\s+(?:calendar\s+|insured\s+|working\s+|dispatched\s+)?day\b|daily\b)/i;
const WEEK_TAG =
  /^,?\s*(?:(?:[a-z]+\s+){0,2}?(?:per|a|each|every)\s+(?:weekly\s+|pay\s+)?(?:week|settlement)\b|weekly\b)/i;

function centsOf(whole: string, fraction: string | undefined): number | null {
  const w = Number(whole.replace(/,/g, ""));
  if (!Number.isSafeInteger(w)) return null;
  const f = fraction === undefined ? 0 : Number(fraction.padEnd(2, "0"));
  const cents = w * 100 + f;
  return Number.isSafeInteger(cents) ? cents : null;
}

export function amountsOf(text: string): Amount[] {
  const t = normalize(text);
  const out: Amount[] = [];
  for (const m of t.matchAll(AMOUNT)) {
    const cents = m[1] !== undefined ? centsOf(m[1], m[2]) : centsOf(m[3], m[4]);
    if (cents === null || m.index === undefined) continue;
    const end = m.index + m[0].length;
    const next = t.indexOf("$", end);
    const tail = t.slice(end, next === -1 ? end + 48 : Math.min(next, end + 48));
    const tag: AmountTag = DAY_TAG.test(tail) ? "day" : WEEK_TAG.test(tail) ? "week" : null;
    out.push({ cents, tag, at: m.index, end });
  }
  return out;
}

// "74 percent", "75%", "12.5 per cent"; "half", "a quarter", "three quarters".
const PERCENT = /\b(\d{1,3})(?:\.(\d{1,2}))?\s*(?:percent\b|per cent\b|%)/gi;
const PERCENT_WORDS: readonly [RegExp, number][] = [
  [/\bthree quarters\b/i, 7_500],
  [/\b(?:a|one) quarter\b/i, 2_500],
  [/\bhalf\b/i, 5_000],
];

export function percentsOf(text: string): number[] {
  const t = normalize(text);
  const out: number[] = [];
  for (const m of t.matchAll(PERCENT)) {
    const bps = Number(m[1]) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0")));
    if (Number.isSafeInteger(bps)) out.push(bps);
  }
  let rest = t;
  for (const [re, bps] of PERCENT_WORDS) {
    if (re.test(rest)) {
      out.push(bps);
      rest = rest.replace(re, " ");
    }
  }
  return out;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// The first weekday the text names: 0 Sunday to 6 Saturday.
export function weekdayOf(text: string): number | null {
  const m = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(normalize(text));
  return m ? WEEKDAYS.indexOf(m[1].toLowerCase()) : null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const pad = (n: number) => String(n).padStart(2, "0");

// The first date the text names: "November 2, 2026", "11/02/2026" or "2026-11-02".
export function dateOf(text: string): LocalDate | null {
  const t = normalize(text);
  const named = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(t);
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  const found = [
    named && { at: named.index, d: `${named[3]}-${pad(MONTHS.indexOf(named[1].toLowerCase()) + 1)}-${pad(Number(named[2]))}` },
    slashed && { at: slashed.index, d: `${slashed[3]}-${pad(Number(slashed[1]))}-${pad(Number(slashed[2]))}` },
    iso && { at: iso.index, d: `${iso[1]}-${iso[2]}-${iso[3]}` },
  ]
    .filter((x): x is { at: number; d: string } => x !== null)
    .sort((a, b) => a.at - b.at);
  const first = found[0];
  return first && isLocalDate(first.d) ? first.d : null;
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// Minutes: "two hours", "90 minutes", "1 hour".
export function minutesOf(text: string): number | null {
  const m = /\b(\d{1,3}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(hours?|minutes?)\b/i.exec(
    normalize(text),
  );
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : SMALL.indexOf(m[1].toLowerCase());
  return m[2].toLowerCase().startsWith("hour") ? n * 60 : n;
}

// "$3 to $5", "$3-$5", "between $3 and $5": the two ends, low first.
export function rangeOf(text: string): [number, number] | null {
  const t = normalize(text);
  const money = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?`;
  const m =
    new RegExp(`between\\s+${money}\\s+and\\s+${money}`, "i").exec(t) ??
    new RegExp(`${money}\\s*(?:to|-)\\s*${money}`, "i").exec(t);
  if (!m) return null;
  const a = centsOf(m[1], m[2]);
  const b = centsOf(m[3], m[4]);
  if (a === null || b === null || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

function appliesOf(text: string): string[] {
  const t = normalize(text);
  const out: string[] = [];
  if (/\bowner[- ]?operators?\b/i.test(t)) out.push("owner_operator");
  if (/\b(?:all|every|each)\s+(?:of\s+(?:its|our|the)\s+)?(?:company\s+)?drivers?\b/i.test(t)) out.push("all");
  return out;
}

function baseOf(text: string): string[] {
  const t = normalize(text).replace(/line[- ]haul/gi, "linehaul");
  if (/linehaul,?\s+(?:the\s+)?fuel surcharge,?\s+and\s+(?:the\s+|all\s+)?(?:accessorial|extra)/i.test(t)) {
    return ["linehaul_fsc_accessorials"];
  }
  if (/linehaul\s+(?:and|plus)\s+(?:the\s+)?fuel surcharge/i.test(t)) return ["linehaul_fsc"];
  if (/linehaul/i.test(t)) return ["linehaul"];
  return [];
}

const NO_CAP = /\bno\s+(?:cap|limit|maximum)\b/i;

function valid(key: RuleKey, raw: RuleValue): boolean {
  try {
    parseValue(RULES[key], raw);
    return true;
  } catch (error) {
    if (error instanceof RuleError) return false;
    throw error;
  }
}

const distinct = (values: RuleValue[]): RuleValue[] => [...new Set(values)];

export type Candidates = {
  // Every value the text states for the rule, in range, once each.
  values: RuleValue[];
  // The text gives the value as a range ("$3 to $5"): never a guessed value.
  range: [RuleValue, RuleValue] | null;
  // A per-day rule's weekly figure that is not 7 times a daily one.
  weekMismatch: boolean;
};

// The values a quote states for one rule. A per-day rule reads amounts not counted by the week,
// and each weekly amount must be 7 times one of them; escrow per week reads amounts not counted
// by the day; the escrow target reads amounts counted by neither; any other dollar rule reads
// amounts not counted by the day.
export function candidatesFor(key: RuleKey, text: string): Candidates {
  const spec = RULES[key];
  const none: Candidates = { values: [], range: null, weekMismatch: false };
  if (spec.unit === "enum") {
    const values = key === "insurance_applies_to" ? appliesOf(text) : baseOf(text);
    return { ...none, values: values.filter((v) => valid(key, v)) };
  }
  if (spec.unit === "bps") return { ...none, values: distinct(percentsOf(text)).filter((v) => valid(key, v)) };
  const values: RuleValue[] = [];
  if (spec.nullable && NO_CAP.test(normalize(text))) values.push(null);
  const amounts = amountsOf(text);
  let usable: Amount[];
  if (spec.unit === "cents_per_day") usable = amounts.filter((a) => a.tag !== "week");
  else if (spec.unit === "cents_per_settlement") usable = amounts.filter((a) => a.tag !== "day");
  else if (key === "escrow_target_cents") usable = amounts.filter((a) => a.tag === null);
  else usable = amounts.filter((a) => a.tag !== "day");
  for (const a of usable) values.push(a.cents);
  const inRange = distinct(values).filter((v) => valid(key, v));
  const r = rangeOf(text);
  const range = r && usable.some((a) => a.cents === r[0]) && usable.some((a) => a.cents === r[1]) ? r : null;
  const weekly = spec.unit === "cents_per_day" ? amounts.filter((a) => a.tag === "week") : [];
  const weekMismatch = weekly.some((w) => !usable.some((d) => d.cents * 7 === w.cents));
  return { values: inRange, range: range && valid(key, range[0]) && valid(key, range[1]) ? range : null, weekMismatch };
}

// The model's value_text read the same way, without the unit words: "$10.50", "75 percent",
// "half", "owner-operators", "linehaul and fuel surcharge", "no cap". The stored codes
// ("owner_operator", "linehaul_fsc") read as themselves. Undefined when it reads as no one value.
export function valueFromText(key: RuleKey, text: string): RuleValue | undefined {
  const spec = RULES[key];
  const t = normalize(text);
  let found: RuleValue[];
  if (spec.unit === "enum") {
    found = (spec.values ?? []).includes(t) ? [t] : key === "insurance_applies_to" ? appliesOf(t) : baseOf(t);
  } else if (spec.unit === "bps") {
    found = /^\d{1,3}(?:\.\d{1,2})?$/.test(t) ? percentsOf(`${t} percent`) : percentsOf(t);
  } else if (spec.nullable && (NO_CAP.test(t) || /^(?:none|null)$/i.test(t))) {
    found = [null];
  } else {
    const plain = /^(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(t);
    const cents = plain ? centsOf(plain[1], plain[2]) : null;
    found = cents !== null ? [cents] : amountsOf(t).map((a) => a.cents);
  }
  const values = distinct(found);
  if (values.length !== 1 || !valid(key, values[0])) return undefined;
  return values[0];
}
