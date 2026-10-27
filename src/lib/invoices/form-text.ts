// The payment form's fixed rules and its dollar text, with no imports, so the browser form and
// the server check share them without pulling server code into the page.

// QuickBooks keeps a payment's reference in a 21-character field with the tenant's 5-character
// document key and a dash in front (T0001-CHK-20417), and the adapter refuses anything longer, so
// the form takes 15 at most.
export const MAX_PAYMENT_REF = 15;
export const PAYMENT_REF = /^[A-Za-z0-9-]{1,15}$/;
export const PAYMENT_METHODS = ["check", "ach", "wire"] as const;
export const MAX_MEMO = 200;

// A dollar amount as a person types it ("1,250.5", "$80") to integer cents, or null. Digits only,
// at most two decimals, never through a float.
const DOLLARS = /^\$?(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/;

export function dollarsToCents(text: string): number | null {
  const m = DOLLARS.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1].replaceAll(",", ""));
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

// Cents as the form's text ("1250.50"), the inverse of dollarsToCents for a non-negative amount.
export function centsToDollarsText(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError("not a non-negative cents amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
