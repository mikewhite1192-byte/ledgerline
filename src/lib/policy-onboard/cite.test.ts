import { describe, expect, it } from "vitest";
import { citedPassage, citeRule } from "./cite";

// The citations, enforced in code: a passage stands only when its quote is word for word in a
// section the read copied, 12 to 400 characters, and a value is Found only when code reads the
// model's value from the quote itself.

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
