import { describe, expect, it } from "vitest";
import { PAY_CARD_PROMPT, PAY_CARD_READ_FORMAT, parseCardRead, type CardRead } from "./schema";

// What the model read off a card is taken only in exactly the schema's shape; anything else is a
// failed check, never a pass.

const READ: CardRead = {
  net_pay_cents: 117_750,
  earned_cents: 141_200,
  taken_out_cents: 23_450,
  loads: 2,
  miles: 1_950,
  change_cents: 7_750,
  first_name: "Ana",
  week_text: "Week of Oct 19 to Oct 25, 2026",
  other_amounts_cents: [11_200],
  any_other_digits: false,
};

describe("pay card read schema", () => {
  it("takes a read in exactly the schema's shape", () => {
    expect(parseCardRead(JSON.stringify(READ))).toEqual(READ);
    expect(parseCardRead(JSON.stringify({ ...READ, miles: null, change_cents: null, first_name: null }))).not.toBeNull();
  });

  it("refuses anything else", () => {
    expect(parseCardRead("not json")).toBeNull();
    expect(parseCardRead("[]")).toBeNull();
    expect(parseCardRead("null")).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, extra: 1 }))).toBeNull();
    const { loads: _loads, ...missing } = READ;
    expect(parseCardRead(JSON.stringify(missing))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, net_pay_cents: 1177.5 }))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, net_pay_cents: "117750" }))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, other_amounts_cents: [1.5] }))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, other_amounts_cents: Array(21).fill(1) }))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, any_other_digits: "no" }))).toBeNull();
    expect(parseCardRead(JSON.stringify({ ...READ, first_name: "x".repeat(201) }))).toBeNull();
  });

  it("names every field in the strict schema, and the prompt holds no figure", () => {
    const schema = PAY_CARD_READ_FORMAT.schema as { required: string[]; additionalProperties: boolean };
    expect(PAY_CARD_READ_FORMAT.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(READ).sort());
    // The only digits in the prompt are the cents example, so the read cannot copy an answer.
    expect(PAY_CARD_PROMPT.match(/\d[\d,.]*/g)).toEqual(["1,234.56", "123456", "0"]);
  });
});
