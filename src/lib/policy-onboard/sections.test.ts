import { describe, expect, it } from "vitest";
import { sectionsFromAnswer, sectionsOfTranscript, transcriptOf, TRANSCRIPT_MAX } from "./sections";
import { readAnswerFor, sampleSections } from "./test-fixtures";

// The read call's answer, checked whole: well-formed numbers used once, bounded text, and a
// transcript that reads back into the same sections.

const answer = (sections: unknown) => JSON.stringify({ sections });

describe("the read answer", () => {
  it("takes each sample's paragraphs as copied and reads its transcript back", () => {
    for (const name of ["harrow-flats-pay-policy", "cedar-bend-pay-policy"] as const) {
      const sections = sectionsFromAnswer(readAnswerFor(name));
      expect(sections).toEqual(sampleSections(name));
      const transcript = transcriptOf(sections!);
      expect(transcript.length).toBeLessThanOrEqual(TRANSCRIPT_MAX);
      expect([...sectionsOfTranscript(transcript)!.entries()]).toEqual(sections!.map((s) => [s.number, s.text]));
    }
  });

  it("folds whitespace and control characters and drops a trailing dot from a number", () => {
    expect(sectionsFromAnswer(answer([{ number: "6.1.", text: " The carrier\u0007 withholds\n$125. " }]))).toEqual([
      { number: "6.1", text: "The carrier withholds $125." },
    ]);
  });

  it("keeps a number as printed, dropping only the word or sign before it", () => {
    const printed = [
      { number: "Section 1", text: "a" },
      { number: "Sec. 2.1", text: "b" },
      { number: "Article II", text: "c" },
      { number: "\u00a7 4.1A", text: "d" },
      { number: "B.", text: "e" },
      { number: "Para 6", text: "f" },
    ];
    expect(sectionsFromAnswer(answer(printed))?.map((s) => s.number)).toEqual(["1", "2.1", "II", "4.1A", "B", "6"]);
    const sections = sectionsFromAnswer(answer(printed))!;
    expect([...sectionsOfTranscript(transcriptOf(sections))!.keys()]).toEqual(["1", "2.1", "II", "4.1A", "B", "6"]);
  });

  it("never renumbers: a number that still does not read, or two labels for one number, refuses the read", () => {
    for (const odd of ["1(a)", "Schedule A-1", "AB", "ii", "Section", "\u00a7"]) {
      expect(sectionsFromAnswer(answer([{ number: "1", text: "a" }, { number: odd, text: "b" }])), odd).toBeNull();
    }
    expect(sectionsFromAnswer(answer([{ number: "Article 3", text: "a" }, { number: "Section 3", text: "b" }]))).toBeNull();
  });

  it("refuses an empty, malformed, duplicated or oversized read, never part of one", () => {
    expect(sectionsFromAnswer("not json")).toBeNull();
    expect(sectionsFromAnswer(answer([]))).toBeNull();
    expect(sectionsFromAnswer(JSON.stringify({ sections: [], extra: 1 }))).toBeNull();
    expect(sectionsFromAnswer(answer([{ number: "six", text: "x" }]))).toBeNull();
    expect(sectionsFromAnswer(answer([{ number: "1.1", text: "a" }, { number: "1.1", text: "b" }]))).toBeNull();
    expect(sectionsFromAnswer(answer([{ number: "1.1", text: "   " }]))).toBeNull();
    expect(sectionsFromAnswer(answer([{ number: "1.1", text: "x".repeat(1_201) }]))).toBeNull();
    const many = Array.from({ length: 81 }, (_, i) => ({ number: String(i + 1), text: "x" }));
    expect(sectionsFromAnswer(answer(many))).toBeNull();
    const long = Array.from({ length: 30 }, (_, i) => ({ number: String(i + 1), text: "x".repeat(1_000) }));
    expect(sectionsFromAnswer(answer(long))).toBeNull();
  });

  it("reads back no transcript a line of which is not a section", () => {
    expect(sectionsOfTranscript("1.1 fine\nnot a section")).toBeNull();
    expect(sectionsOfTranscript("1.1 a\n1.1 b")).toBeNull();
    expect(sectionsOfTranscript("")).toBeNull();
  });
});
