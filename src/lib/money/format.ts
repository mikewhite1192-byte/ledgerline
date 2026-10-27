// Cents to and from the decimal strings outside systems speak, built from integers only: no
// float ever carries money. Pure.

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) throw new RangeError("cents must be a safe integer");
}

// 123456 -> "1234.56", 5 -> "0.05", -250 -> "-2.50".
export function centsToDecimalString(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  return `${sign}${whole}.${String(part).padStart(2, "0")}`;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

// "1234.56" -> 123456. Only plain decimals with at most two places: no exponent, no plus sign,
// no thousands separators, no third decimal place (it would have to be rounded, and money is
// never rounded on the way in).
export function decimalToCents(text: string): number {
  if (typeof text !== "string") throw new RangeError("amount is not text");
  const m = DECIMAL.exec(text);
  if (!m) throw new RangeError("amount is not a plain decimal with at most two places");
  const whole = Number(m[2]);
  const part = Number((m[3] ?? "").padEnd(2, "0"));
  const abs = whole * 100 + part;
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(abs)) {
    throw new RangeError("amount is too large");
  }
  return m[1] === "-" && abs !== 0 ? -abs : abs;
}

// For cards: 123456 -> "$1,234.56", -5 -> "-$0.05".
export function dollars(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}
