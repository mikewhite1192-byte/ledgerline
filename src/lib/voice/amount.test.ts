import { describe, expect, it } from "vitest";
import { extractAmountCents } from "./amount";

// The ask, read from the driver's own words without a model: digits with a dollar sign or a
// currency word, and number words in English and Spanish. No amount is null, never a guess.

describe("extractAmountCents", () => {
  it.each([
    ["Can I get $300 for fuel?", 30_000],
    ["I need $ 300.50 today", 30_050],
    ["about 300 dollars please", 30_000],
    ["necesito 300 dólares", 30_000],
    ["necesito 300 dolares", 30_000],
    ["$1,200.75 for repairs", 120_075],
    ["1.200 dólares", 120_000],
    ["three hundred dollars", 30_000],
    ["two hundred fifty dollars for fuel", 25_000],
    ["a hundred bucks", 10_000],
    ["un adelanto de trescientos dólares para diésel", 30_000],
    ["Necesito un adelanto de trescientos dólares para diésel esta semana, por favor.", 30_000],
    ["quinientos cincuenta dólares", 55_000],
    ["treinta y cinco dólares", 3_500],
    ["mil dólares", 100_000],
    ["dos mil quinientos dólares", 250_000],
    ["ciento veinte dólares", 12_000],
    ["one thousand two hundred dollars", 120_000],
    ["first $200, then later $500", 20_000],
  ])("%s is %i cents", (text, cents) => {
    expect(extractAmountCents(text)).toBe(cents);
  });

  it.each([
    "Why is my pay lower this week?",
    "¿Por qué mi pago de esta semana es más bajo?",
    "I drove 300 miles",
    "un adelanto de trescientos",
    "truck 4 is in the shop",
    "$0 for now",
    "",
    "$5,000,001 dollars",
  ])("%s states no amount", (text) => {
    expect(extractAmountCents(text)).toBeNull();
  });

  it("refuses anything that is not text", () => {
    expect(extractAmountCents(undefined as unknown as string)).toBeNull();
    expect(extractAmountCents(300 as unknown as string)).toBeNull();
  });
});
