// The agent never computes money in its own text: every figure must come from a tool result in
// integer cents (or the state summary). A dollar or cents figure in the final answer that matches
// none of them is replaced with a fixed note, and the count goes on the turn's step detail.

export const WITHHELD = "[amount not from a record]";

const DOLLARS = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g;
const CENTS = /\b(\d{1,3}(?:,\d{3})+|\d+)\s?cents\b/gi;

// Every value under a key ending in "cents" (any case), anywhere in a tool result.
export function centsIn(value: unknown, into: Set<number> = new Set(), depth = 0): Set<number> {
  if (depth > 12 || value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const v of value) centsIn(v, into, depth + 1);
    return into;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/cents$/i.test(k)) {
      const nums = Array.isArray(v) ? v : [v];
      for (const n of nums) if (typeof n === "number" && Number.isSafeInteger(n)) into.add(Math.abs(n));
    }
    centsIn(v, into, depth + 1);
  }
  return into;
}

function digits(s: string): number {
  return Number(s.replace(/,/g, ""));
}

export function maskFigures(text: string, allowed: ReadonlySet<number>): { text: string; masked: number } {
  let masked = 0;
  const check = (cents: number, original: string) => {
    if (Number.isSafeInteger(cents) && allowed.has(cents)) return original;
    masked += 1;
    return WITHHELD;
  };
  const out = text
    .replace(DOLLARS, (m, whole: string, frac: string | undefined) => {
      const fraction = frac === undefined ? 0 : frac.length === 1 ? digits(frac) * 10 : digits(frac);
      return check(digits(whole) * 100 + fraction, m);
    })
    .replace(CENTS, (m, n: string) => check(digits(n), m));
  return { text: out, masked };
}
