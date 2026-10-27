import { describe, expect, it } from "vitest";
import { isVoiceMime, voiceMime } from "./mime";
import { costWords, languageLabel, noticeFor, purposeLabel, statusWords, stoppedWords, targetLabel } from "./words";

// The pages' fixed words: a known category gets its sentence, anything else the one fallback, so
// no server or model text is ever shown through them.

describe("voice words", () => {
  it("gives a sentence per known category and the fallback for anything else", () => {
    expect(noticeFor("cap")).toMatch(/^Demo budget reached/);
    expect(noticeFor("limit")).toMatch(/limit/);
    expect(noticeFor("too_large")).toMatch(/too big/);
    const fallback = noticeFor(null);
    expect(noticeFor("Upstream said: 500 Internal Server Error")).toBe(fallback);
    expect(noticeFor("toString")).toBe(fallback);
    expect(noticeFor(undefined)).toBe(fallback);
  });

  it("labels every status and words an unknown one", () => {
    expect(statusWords("blocked")).toEqual({ label: "Held by the screen", tone: "warning" });
    expect(statusWords("replied").tone).toBe("success");
    expect(statusWords("odd_state")).toEqual({ label: "Odd state", tone: "neutral" });
  });

  it("says why a note stopped without its words", () => {
    expect(stoppedWords("blocked", "ok")).toMatch(/held this note/);
    expect(stoppedWords("blocked", "screen_error")).toMatch(/could not check/);
    expect(stoppedWords("failed", "no_speech")).toBe("No speech was heard in that clip.");
  });

  it("names the model behind each step", () => {
    expect(targetLabel("voice")).toBe("Muse Voice Transcribe");
    expect(targetLabel("spark_open")).toBe("Muse Spark Open");
    expect(targetLabel("spark")).toBe("Muse Spark");
    expect(purposeLabel("voice_note_prepare")).toMatch(/English copy/);
    expect(purposeLabel("something_new")).toBe("Something new");
    expect(languageLabel("es")).toBe("Spanish");
    expect(languageLabel(null)).toBe("Not known yet");
    expect(costWords(30_000_000)).toBe("0.03¢");
    expect(costWords(31_000_000)).toBe("0.04¢");
  });
});

describe("voiceMime", () => {
  it("folds a browser's type into one of ours and refuses the rest", () => {
    expect(voiceMime("audio/webm; codecs=vorbis")).toBe("audio/webm");
    expect(voiceMime("audio/x-wav")).toBe("audio/wav");
    expect(voiceMime("Audio/X-M4A")).toBe("audio/mp4");
    expect(isVoiceMime(voiceMime("audio/mp3"))).toBe(true);
    expect(isVoiceMime(voiceMime("video/mp4"))).toBe(false);
    expect(isVoiceMime(voiceMime(""))).toBe(false);
  });
});
