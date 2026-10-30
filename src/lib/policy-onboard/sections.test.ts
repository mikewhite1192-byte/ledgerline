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
