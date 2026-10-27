import { describe, expect, it } from "vitest";
import { ENGLISH_TEXT_CHARS, PREPARE_FORMAT, PREPARE_INPUT_CHARS, parsePrepared } from "./prepare";

// The language and English copy, checked: only the exact JSON shape passes, an English note is its
// own transcript (never the model's rewrite), and the confidence is stored in thousandths.

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ language: "es", confidence: 0.97, english_text: "I need a $300 advance.", summary: "Asks for an advance.", ...over });

describe("parsePrepared", () => {
  it("keeps the language, the confidence in thousandths and the English copy", () => {
    expect(parsePrepared(answer(), "Necesito un adelanto de 300 dólares.")).toEqual({
      language: "es",
      confidenceMilli: 970,
      englishText: "I need a $300 advance.",
    });
  });

  it("uses the transcript itself for an English note, whatever the model wrote", () => {
    const transcript = "Hi, can I get two hundred fifty dollars for fuel?";
    expect(parsePrepared(answer({ language: "en", english_text: "Something else entirely." }), transcript)?.englishText).toBe(transcript);
    expect(parsePrepared(answer({ language: "en", english_text: "" }), "x".repeat(PREPARE_INPUT_CHARS + 5))?.englishText).toHaveLength(
      PREPARE_INPUT_CHARS,
    );
  });

  it.each([
    ["not JSON", "The driver wants money."],
    ["a missing field", JSON.stringify({ language: "es", confidence: 0.9, english_text: "x" })],
    ["an extra field", answer({ amount: 300 })],
    ["another language code", answer({ language: "fr" })],
    ["a confidence past 1", answer({ confidence: 1.5 })],
    ["an empty English copy", answer({ english_text: "   " })],
    ["an English copy past the cap", answer({ english_text: "x".repeat(ENGLISH_TEXT_CHARS + 1) })],
  ])("refuses %s", (_label, text) => {
    expect(parsePrepared(text, "Hola")).toBeNull();
  });

  it("asks for exactly the fields it parses", () => {
    expect(PREPARE_FORMAT.schema).toMatchObject({
      required: ["language", "confidence", "english_text", "summary"],
      additionalProperties: false,
    });
  });
});
