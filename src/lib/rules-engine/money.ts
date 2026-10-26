import { InputError, type Cents } from "./types";

// Integer money. Every input is an integer (cents, basis points, whole miles, thousandths of a
// gallon), every product is checked to be a safe integer, and this is the only file in the
// engine that divides. No floats, no BigInt: the largest product is 10^9 cents x 10^4 bps.

export const BPS = 10_000;
// The tables' CHECK: every stored amount is at least 0 and under 10^9 cents.
export const MAX_STORED_CENTS = 999_999_999;

function safe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new InputError(`${what} is not a safe integer`);
  return value;
}

// Any whole number of cents, signed (a deduction line is negative).
export function cents(value: number, what = "amount"): Cents {
  return safe(value, what) as Cents;
}

// A stored amount: a safe integer from 0 to under 10^9 cents.
export function assertCents(value: unknown, what: string): Cents {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InputError(`${what} is not a whole number of cents`);
  }
  if (value < 0 || value > MAX_STORED_CENTS) throw new InputError(`${what} is out of range`);
  return value as Cents;
}

// A non-negative whole count (miles, days, thousandths of a gallon).
export function assertCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(`${what} is not a whole number`);
  }
  return value;
}

export function mul(a: number, b: number, what = "product"): number {
  safe(a, what);
  safe(b, what);
  return safe(a * b, what);
}

// numerator / denominator rounded half up, on integers only. Same result as
// Math.floor((n + d / 2) / d), computed from the remainder so no step is ever fractional.
export function roundHalfUp(numerator: number, denominator: number): number {
  safe(numerator, "numerator");
  safe(denominator, "denominator");
  if (numerator < 0) throw new InputError("numerator is negative");
  if (denominator <= 0) throw new InputError("denominator is not positive");
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  return safe(remainder * 2, "remainder") >= denominator ? quotient + 1 : quotient;
}

// amount x bps / 10000, rounded half up. Applied per load, never on a total.
export function mulBps(amount: number, bps: number): Cents {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > BPS) {
    throw new InputError("basis points out of range");
  }
  return roundHalfUp(mul(amount, bps, "amount x bps"), BPS) as Cents;
}

export function sum(values: readonly number[]): Cents {
  let total = 0;
  for (const v of values) total = safe(safe(v, "addend") + total, "sum");
  return total as Cents;
}

export function sub(a: number, b: number): Cents {
  return safe(safe(a, "minuend") - safe(b, "subtrahend"), "difference") as Cents;
}
