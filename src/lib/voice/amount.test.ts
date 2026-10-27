import { describe, expect, it } from "vitest";
import { extractAmountCents, extractAmountsCents } from "./amount";

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
    // Dot thousands, then a comma before exactly two digits of cents.
    ["Necesito 1.200,50 dólares", 120_050],
    ["$1.200,50", 120_050],
    ["1.000.000,00 dólares", 100_000_000],
    // The forms read before the comma-cents form keep their meaning.
    ["1,200.50 dollars", 120_050],
    ["1,200 dollars", 120_000],
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
    // The most a note can hold (the amount_cents CHECK), in digits and in words.
    ["$1,000,000", 100_000_000],
    ["$1,000,000.00", 100_000_000],
    ["ten hundred thousand dollars", 100_000_000],
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
    // Whole dollars at the cap plus cents is past it: no amount, never a row the database refuses.
    "$1,000,000.50",
    "$1,000,000.01",
    "1000000.99 dollars",
    "1.000.000,01 dólares",
    // A comma is a decimal mark only after dot thousands and before exactly two digits.
    "1,5 dólares",
    "1,50 dólares",
    "1.200,5 dólares",
    "1.200,500 dólares",
    "1.20,50 dólares",
  ])("%s states no amount", (text) => {
    expect(extractAmountCents(text)).toBeNull();
  });

  it("refuses anything that is not text", () => {
    expect(extractAmountCents(undefined as unknown as string)).toBeNull();
    expect(extractAmountCents(300 as unknown as string)).toBeNull();
  });
});

describe("extractAmountsCents", () => {
  it.each<[string, number[]]>([
    ["first $200, then later $500", [20_000, 50_000]],
    ["Tu adelanto de $300.00 fue aprobado. Más cien dólares de bono.", [30_000, 10_000]],
    // One amount per figure, even with a currency word after it.
    ["$300 dollars", [30_000]],
    ["three hundred dollars and $5", [30_000, 500]],
    ["Why is my pay lower this week?", []],
    ["", []],
  ])("%s is %j", (text, cents) => {
    expect(extractAmountsCents(text)).toEqual(cents);
  });

  it("starts with the amount extractAmountCents reads", () => {
    for (const text of ["first $200, then later $500", "$1,000,000.50 then 300 dollars", "ten hundred thousand dollars"]) {
      expect(extractAmountsCents(text)[0]).toBe(extractAmountCents(text));
    }
  });

  it("refuses anything that is not text", () => {
    expect(extractAmountsCents(undefined as unknown as string)).toEqual([]);
  });
});
