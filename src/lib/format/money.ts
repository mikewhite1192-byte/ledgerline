// Money for display. Amounts arrive as integer cents and are only ever split, never rounded: the
// rules engine is the one place that does math on money, this file only writes it down.

export type SignMode = "auto" | "always" | "never";

// U+2212, the true minus sign: it sits at the height of the figures, unlike a hyphen.
export const MINUS = "−";

export function assertSafeCents(cents: unknown): asserts cents is number {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) {
    throw new RangeError("an amount must be a whole number of cents");
  }
}

// 222500 is "$2,225.00"; -20000 is "−$200.00"; sign "always" puts "+" before a positive amount.
// Zero is never signed. Anything but a safe integer throws instead of guessing.
export function formatCents(cents: number, opts: { sign?: SignMode } = {}): string {
  assertSafeCents(cents);
  const sign = opts.sign ?? "auto";
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const rest = abs % 100;
  const body = `$${dollars.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
  if (abs === 0 || sign === "never") return body;
  if (cents < 0) return `${MINUS}${body}`;
  return sign === "always" ? `+${body}` : body;
}
