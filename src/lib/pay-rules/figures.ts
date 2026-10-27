import type { RuleSpec, RuleValue } from "./rules";

// The guard against a model inventing a number: a rule change's new value must appear in the
// sentence the person typed. This is not a parse of the sentence (the model reads it); it only
// lists the figures the sentence contains, each as the integer the rule's unit needs, and the
// change is refused when its value is not one of them. Pure.

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// Dates are not amounts: "Nov 2", "November 9th", "2 Nov", "2026-11-02", "11/2", and the year
// written after a month and day.
const DATES = [
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s*\\d{4})?`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s*\\d{4})?`, "gi"),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
];

const NUMBER = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";

// "12" and "12.5" as hundredths: 1200 and 1250. Null for anything that is not a whole number of
// hundredths or is out of safe range.
function hundredths(whole: string, frac: string | undefined): number | null {
  const n = Number(whole.replace(/,/g, ""));
  const f = frac === undefined ? 0 : Number(frac.padEnd(2, "0"));
  const value = n * 100 + f;
  return Number.isSafeInteger(value) ? value : null;
}

function wholeOf(whole: string, frac: string | undefined): number | null {
  if (frac !== undefined) return null;
  const n = Number(whole.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

type Kind = "money" | "bps";

// Every figure in the text, as cents (money) or basis points (bps).
export function figuresIn(text: string, kind: Kind): Set<number> {
  let rest = text;
  for (const d of DATES) rest = rest.replace(d, " ");
  const out = new Set<number>();
  const add = (v: number | null) => {
    if (v !== null) out.add(v);
  };
  // Explicit forms first, each blanked out once read so a bare-number pass cannot read it again.
  const take = (re: RegExp, read: (m: RegExpExecArray) => void) => {
    rest = rest.replace(re, (...args) => {
      read(args.slice(0, -2) as unknown as RegExpExecArray);
      return " ";
    });
  };
  if (kind === "money") {
    take(new RegExp(`\\$\\s?${NUMBER}`, "g"), (m) => add(hundredths(m[1], m[2])));
    take(new RegExp(`${NUMBER}\\s*(?:dollars?|bucks?)\\b`, "gi"), (m) => add(hundredths(m[1], m[2])));
    take(new RegExp(`${NUMBER}\\s*(?:cents?|¢)`, "gi"), (m) => add(wholeOf(m[1], m[2])));
    // Percent figures are not money.
    take(new RegExp(`${NUMBER}\\s*(?:%|percent\\b|bps\\b|basis points?\\b)`, "gi"), () => {});
  } else {
    take(new RegExp(`${NUMBER}\\s*(?:%|percent\\b)`, "gi"), (m) => add(hundredths(m[1], m[2])));
    take(new RegExp(`${NUMBER}\\s*(?:bps|basis points?)\\b`, "gi"), (m) => add(wholeOf(m[1], m[2])));
    // Money figures are not percentages.
    take(new RegExp(`\\$\\s?${NUMBER}`, "g"), () => {});
    take(new RegExp(`${NUMBER}\\s*(?:dollars?|bucks?|cents?)\\b`, "gi"), () => {});
  }
  // A bare number reads as dollars for a money rule and as a percentage for a share.
  take(new RegExp(`(?<![\\w.])${NUMBER}(?![\\w]|\\.\\d)`, "g"), (m) => add(hundredths(m[1], m[2])));
  return out;
}

// The words that name each enum value or "no cap". Whole words, any case. A share rule's base is
// told apart by what else the sentence names.
const ALIASES: Readonly<Record<string, readonly RegExp[]>> = {
  owner_operator: [/\bowner[\s-]?operators?\b/i],
  all: [/\beveryone\b/i, /\ball drivers\b/i, /\bevery driver\b/i, /\ball of (?:the|our) drivers\b/i],
};

function namesBase(text: string, value: string): boolean {
  const fuel = /\bfuel\b|\bsurcharge\b|\bfsc\b/i.test(text);
  // The screen says "extra charges"; a person who knows the trade word may say "accessorials".
  const acc = /\baccessorials?\b|\bextra charges?\b/i.test(text);
  if (value === "linehaul_fsc_accessorials") return acc && /\blinehaul\b/i.test(text);
  if (value === "linehaul_fsc") return fuel && !acc;
  if (value === "linehaul") return /\blinehaul\b/i.test(text) && !fuel && !acc;
  return false;
}

const NO_CAP = /\bno cap\b|\buncapped\b/i;

// Whether the person's sentence contains the value: a cents or bps value is one of the sentence's
// figures (compared whole), an enum value is named by one of its words, and null needs "no cap".
export function valueInText(spec: RuleSpec, value: RuleValue, text: string): boolean {
  if (value === null) return spec.nullable && NO_CAP.test(text);
  if (typeof value === "string") {
    if (spec.key === "percent_base") return namesBase(text, value);
    return (ALIASES[value] ?? []).some((re) => re.test(text));
  }
  const kind: Kind = spec.unit === "bps" ? "bps" : "money";
  return figuresIn(text, kind).has(value);
}
