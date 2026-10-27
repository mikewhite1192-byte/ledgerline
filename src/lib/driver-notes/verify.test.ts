import { describe, expect, it } from "vitest";
import { MAX_BODY_CHARS, normalizeNumber, parseReply, verifyNote, type NoteCheck } from "./verify";

const CHECK: NoteCheck = {
  language: "en",
  allowedCents: [123456, -12000, 50, 62],
  allowedNumbers: ["2026", "10", "26", "11", "1", "3", "1042", "25", "72.5"],
  seqs: [1, 2, 3],
};

function reply(body: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ language: "English", body, cited_seqs: [], ...extra });
}

describe("parseReply", () => {
  it("takes exactly the three keys with their types", () => {
    expect(parseReply(reply("Hello there."))).toEqual({ language: "English", body: "Hello there.", cited_seqs: [] });
    expect(parseReply("not json")).toBeNull();
    expect(parseReply("[]")).toBeNull();
    expect(parseReply(JSON.stringify({ language: "English", body: "Hi." }))).toBeNull();
    expect(parseReply(reply("Hi.", { extra: 1 }))).toBeNull();
    expect(parseReply(reply("Hi.", { language: "French" }))).toBeNull();
    expect(parseReply(reply("Hi.", { cited_seqs: [1.5] }))).toBeNull();
    expect(parseReply(reply("Hi.", { cited_seqs: ["1"] }))).toBeNull();
    expect(parseReply(reply("Hi.", { cited_seqs: Array.from({ length: 101 }, () => 1) }))).toBeNull();
    expect(parseReply(JSON.stringify({ language: "English", body: 5, cited_seqs: [] }))).toBeNull();
  });
});

describe("normalizeNumber", () => {
  it("drops leading and trailing zeros only", () => {
    expect(normalizeNumber("072.50")).toBe("72.5");
    expect(normalizeNumber("0")).toBe("0");
    expect(normalizeNumber("10")).toBe("10");
    expect(normalizeNumber("1.0")).toBe("1");
    expect(normalizeNumber("01")).toBe("1");
  });
});

describe("verifyNote", () => {
  it("passes a note whose every number is on the paystub, with its citations", () => {
    const result = verifyNote(
      reply("Your net pay is $1,234.56 for 3 loads and 1042 loaded miles [line 1]. Fuel took $120.00 [lines 2 and 3].", {
        cited_seqs: [1],
      }),
      CHECK,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.citedSeqs).toEqual([1, 2, 3]);
    expect(result.verification.found).toEqual([12000, 123456]);
    expect(result.verification.numbers).toEqual(["1042", "3"]);
    expect(result.verification.category).toBeNull();
    expect(result.verification.allowed).toEqual([50, 62, 12000, 123456]);
  });

  it("reads each money form to cents, sign ignored", () => {
    for (const body of [
      "Your pay is 1,234.56 dollars.",
      "Your pay is 1234.56 dollars.",
      "Your pay is US$1,234.56.",
      "Your pay is USD 1234.56.",
      "Your pay is 1234.56 today.",
      "Su pago es 1,234.56 dólares.",
      "A deduction of −$120.00 came out.",
      "Your bonus is 50 cents.",
      "Your rate is 62 cents a mile.",
    ]) {
      const check = body.startsWith("Su") ? { ...CHECK, language: "es" as const } : CHECK;
      const language = body.startsWith("Su") ? "Spanish" : "English";
      const result = verifyNote(reply(body, { language }), check);
      expect(result.ok, body).toBe(true);
    }
  });

  it("refuses a dollar amount that is not on the paystub", () => {
    const result = verifyNote(reply("Your net pay is $1,234.57 this week."), CHECK);
    expect(result).toMatchObject({ ok: false, category: "number_mismatch" });
    if (result.ok) return;
    expect(result.verification.found).toEqual([123457]);
  });

  it("refuses a bare two-decimal figure that is not on the paystub", () => {
    expect(verifyNote(reply("You earned 99.99 more."), CHECK)).toMatchObject({ ok: false, category: "number_mismatch" });
  });

  it("refuses a bare number, a percent or a date part that is not on the paystub", () => {
    for (const body of ["You drove 999 miles.", "You keep 30% of linehaul.", "Paid on Oct 30."]) {
      expect(verifyNote(reply(body), CHECK), body).toMatchObject({ ok: false, category: "number_mismatch" });
    }
    expect(verifyNote(reply("You keep 25% of linehaul and drove 72.5 empty miles."), CHECK).ok).toBe(true);
  });

  it("refuses a figure it cannot read with certainty", () => {
    for (const body of [
      "Your pay is $1.234,56 this week.",
      "Your pay is 1,23 dollars.",
      "Your bonus is 50.5 cents.",
      "Your pay is $1234567890123.",
      "Your pay is $12.5 this week.",
    ]) {
      expect(verifyNote(reply(body), CHECK), body).toMatchObject({ ok: false, category: "number_mismatch" });
    }
  });

  it("refuses a cited line that is not on the paystub, in the body or the list", () => {
    expect(verifyNote(reply("See the fuel line [line 9]."), CHECK)).toMatchObject({ ok: false, category: "line_mismatch" });
    expect(verifyNote(reply("See the fuel line.", { cited_seqs: [9] }), CHECK)).toMatchObject({
      ok: false,
      category: "line_mismatch",
    });
    expect(verifyNote(reply("See the fuel line [line 1 or 2]."), CHECK)).toMatchObject({
      ok: false,
      category: "line_mismatch",
    });
    // A bracket with no line number is text, not a citation.
    expect(verifyNote(reply("See the fuel line [lines]."), CHECK).ok).toBe(true);
  });

  it("reads Spanish citations", () => {
    const result = verifyNote(
      reply("Su pago neto es $1,234.56 [líneas 1, 2 y 3].", { language: "Spanish" }),
      { ...CHECK, language: "es" },
    );
    expect(result).toMatchObject({ ok: true, citedSeqs: [1, 2, 3] });
  });

  it("refuses a note in the wrong language", () => {
    expect(verifyNote(reply("Su pago neto es $1,234.56.", { language: "Spanish" }), CHECK)).toMatchObject({
      ok: false,
      category: "language",
    });
    expect(verifyNote(reply("Your net pay is $1,234.56."), { ...CHECK, language: "es" })).toMatchObject({
      ok: false,
      category: "language",
    });
  });

  it("holds the body to its length", () => {
    const fits = `${"A".repeat(MAX_BODY_CHARS - 1)}.`;
    expect(verifyNote(reply(fits), CHECK).ok).toBe(true);
    expect(verifyNote(reply(`A${fits}`), CHECK)).toMatchObject({ ok: false, category: "format" });
    expect(verifyNote(reply("   "), CHECK)).toMatchObject({ ok: false, category: "format" });
  });

  it("refuses hidden characters, links and text that is not a sentence", () => {
    for (const body of [
      "Your pay is ready\u202e today.",
      "Your pay\u200b is ready.",
      "Your pay\tis ready.",
      "Your pay\u0007 is ready.",
      "See https://pay.example for your pay.",
      "See www.pay.example for your pay.",
      "$1,234.56",
      "Your pay is ready",
      "not json at all",
    ]) {
      const text = body === "not json at all" ? body : reply(body);
      expect(verifyNote(text, CHECK), body).toMatchObject({ ok: false, category: "format" });
    }
    expect(verifyNote(reply("Your pay is ready.\nYour paystub has every line."), CHECK).ok).toBe(true);
  });

  it("stores amounts and numbers on a refusal, never the text", () => {
    const result = verifyNote(reply("You drove 999 miles for $5.00."), CHECK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.verification).toEqual({
      allowed: [50, 62, 12000, 123456],
      found: [500],
      numbers: ["999"],
      category: "number_mismatch",
    });
    expect(JSON.stringify(result)).not.toContain("drove");
  });
});
