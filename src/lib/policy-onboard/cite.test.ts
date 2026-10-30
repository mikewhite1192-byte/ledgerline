import { describe, expect, it } from "vitest";
import { citedPassage, citeRule, namesRule } from "./cite";

// The citations, enforced in code: a passage stands only when its quote is word for word in a
// section the read copied, 12 to 400 characters, and a value is Found only when the quote names
// its rule and code reads the model's value from the quote itself.

const SECTIONS = new Map([
  ["9.1", "A driver may ask for an advance. Each advance carries a $3 fee."],
  ["9.4", "No deduction of any kind may take a driver\u2019s weekly net pay under $300."],
  ["6.2", "Escrow is not withheld in any week that would bring weekly net pay under $350."],
]);

describe("a cited passage", () => {
  it("stands when the quote is in its section, whitespace and quotes folded", () => {
    expect(citedPassage(SECTIONS, { section: " 9.4 ", quote: "a  driver's weekly\nnet pay under $300" })).toEqual({
      section: "9.4",
      quote: "a driver's weekly net pay under $300",
      paragraph: SECTIONS.get("9.4"),
    });
  });

  it("falls when the quote is not in the section, too short, too long, or the section is unknown", () => {
    expect(citedPassage(SECTIONS, { section: "9.1", quote: "carries a $4 fee" })).toBeNull();
    expect(citedPassage(SECTIONS, { section: "9.1", quote: "a $3 fee" })).toBeNull();
    expect(citedPassage(SECTIONS, { section: "9.1", quote: "x".repeat(401) })).toBeNull();
    expect(citedPassage(SECTIONS, { section: "9.2", quote: "Each advance carries a $3 fee." })).toBeNull();
    expect(citedPassage(SECTIONS, { section: "9.4", quote: "Each advance carries a $3 fee." })).toBeNull();
  });
});

describe("one rule", () => {
  it("is Found from one passage that code and model read the same", () => {
    const c = citeRule(SECTIONS, "advance_fee_cents", [{ section: "9.1", quote: "Each advance carries a $3 fee.", value_text: "$3" }], 500);
    expect(c).toEqual({
      field: { value: "300", state: "found", passages: [{ section: "9.1", quote: "Each advance carries a $3 fee.", paragraph: SECTIONS.get("9.1") }] },
      conflict: false,
    });
  });

  it("needs a person when two passages give two values, keeping both and the current value", () => {
    const c = citeRule(
      SECTIONS,
      "net_pay_floor_cents",
      [
        { section: "6.2", quote: "weekly net pay under $350", value_text: "$350" },
        { section: "9.4", quote: "weekly net pay under $300", value_text: "$300" },
      ],
      25_000,
    );
    expect(c.conflict).toBe(true);
    expect(c.field.state).toBe("needs_you");
    expect(c.field.value).toBe("25000");
    expect(c.field.passages.map((p) => p.section)).toEqual(["6.2", "9.4"]);
    expect(c.field.alternatives).toEqual([
      { value: "35000", section: "6.2" },
      { value: "30000", section: "9.4" },
    ]);
  });

  it("is Found once when the same passage is given twice", () => {
    const p = { section: "9.1", quote: "Each advance carries a $3 fee.", value_text: "$3" };
    const c = citeRule(SECTIONS, "advance_fee_cents", [p, p], 500);
    expect(c.field.state).toBe("found");
    expect(c.field.passages).toHaveLength(1);
  });

  it("is Not in document with the current value when no passage stands", () => {
    const c = citeRule(SECTIONS, "advance_fee_cents", [{ section: "9.1", quote: "carries a $4 fee", value_text: "$4" }], 500);
    expect(c).toEqual({ field: { value: "500", state: "not_in_document", passages: [] }, conflict: false });
    expect(citeRule(SECTIONS, "advance_recovery_cap_cents", [], null).field.value).toBe("null");
  });

  it("keeps at most two passages", () => {
    const sections = new Map([
      ["1", "The fee is $3 for card one."],
      ["2", "The fee is $4 for card two."],
      ["3", "The fee is $5 for card three."],
    ]);
    const c = citeRule(
      sections,
      "advance_fee_cents",
      ["1", "2", "3"].map((s, i) => ({ section: s, quote: sections.get(s)!, value_text: `$${i + 3}` })),
      500,
    );
    expect(c.field.passages).toHaveLength(2);
    expect(c.field.alternatives).toHaveLength(3);
  });
});

describe("a quote that does not name its rule", () => {
  const sections = new Map([
    ["8.1", "Unless a customer's contract says otherwise, the carrier bills detention at $60 per hour in 15-minute increments."],
    ["9.1", "A driver may ask for an advance. Each advance carries a $3 fee."],
    ["9.5", "The carrier charges $3 on each load it dispatches."],
  ]);

  it("is Found when the quote names the rule and states the value", () => {
    const c = citeRule(sections, "advance_fee_cents", [{ section: "9.1", quote: "Each advance carries a $3 fee.", value_text: "$3" }], 500);
    expect(c.field).toMatchObject({ value: "300", state: "found" });
  });

  it("is never Found from a true figure for another rule: a person chooses", () => {
    const wrong = { section: "8.1", quote: "bills detention at $60 per hour", value_text: "$60" };
    expect(citeRule(sections, "advance_fee_cents", [wrong], 500)).toEqual({
      field: {
        value: "500",
        state: "needs_you",
        passages: [{ section: "8.1", quote: wrong.quote, paragraph: sections.get("8.1") }],
        alternatives: [{ value: "6000", section: "8.1" }],
      },
      conflict: false,
    });
    // Beside the right quote, the rule still waits for a person, with both figures to choose from.
    const both = citeRule(
      sections,
      "advance_fee_cents",
      [{ section: "9.1", quote: "Each advance carries a $3 fee.", value_text: "$3" }, wrong],
      500,
    );
    expect(both.field.state).toBe("needs_you");
    expect(both.field.alternatives).toEqual([
      { value: "300", section: "9.1" },
      { value: "6000", section: "8.1" },
    ]);
    expect(both.conflict).toBe(false);
  });

  it("is never Found from a quote that names no rule at all", () => {
    const c = citeRule(sections, "advance_fee_cents", [{ section: "9.5", quote: "The carrier charges $3 on each load", value_text: "$3" }], 500);
    expect(c.field).toMatchObject({ value: "500", state: "needs_you", alternatives: [{ value: "300", section: "9.5" }] });
    const who = new Map([["3.2", "Leased owner-operators are paid 74 percent of the linehaul."]]);
    const w = citeRule(who, "insurance_applies_to", [{ section: "3.2", quote: "Leased owner-operators are paid 74 percent", value_text: "owner-operators" }], "all");
    expect(w.field.state).toBe("needs_you");
  });

  it("reads a rule's words at the start of a word, any case", () => {
    expect(namesRule("advance_limit_default_cents", "may not owe more than $500 in Advances")).toBe(true);
    expect(namesRule("escrow_per_settlement_cents", "$125 is withheld from each weekly settlement")).toBe(true);
    expect(namesRule("insurance_per_day_cents", "charges each owner-operator $10.50 for each calendar day")).toBe(true);
    expect(namesRule("accessorial_driver_share_bps", "74 percent of the linehaul and fuel surcharge")).toBe(false);
    expect(namesRule("percent_base", "of the line-haul and fuel surcharge")).toBe(true);
    expect(namesRule("advance_fee_cents", "bills detention at $60 per hour")).toBe(false);
  });
});
