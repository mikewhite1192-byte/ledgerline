import { describe, expect, it } from "vitest";
import { agreementText, clipMessage, clipStatusText, clipTime } from "./messages";
import { CLIP_STOPS, type ClipRefusal } from "./types";

const REFUSALS: ClipRefusal[] = [
  "disabled",
  "too_large",
  "unsupported",
  "too_long",
  "limit",
  "duplicate",
  "not_found",
  "busy",
  "failed",
  "budget",
  "store_failed",
  "not_ready",
  "mismatch",
  "unchanged",
  "conflict",
  "read_failed",
  "read_spent",
];

describe("clip messages", () => {
  it("has its own plain sentence for every refusal and falls back for anything else", () => {
    const fallback = clipMessage("unavailable");
    for (const r of REFUSALS) {
      expect(clipMessage(r), r).not.toBe(fallback);
      expect(clipMessage(r)).toMatch(/^[A-Z].*\.$/);
      expect(clipMessage(r)).not.toMatch(/\u2014/);
    }
    expect(clipMessage("constructor")).toBe(fallback);
    expect(clipMessage("ECONNRESET: socket hang up")).toBe(fallback);
  });

  it("names each status and each agreement", () => {
    expect(clipStatusText("redacting")).toBe("Waiting for the blurred clip");
    expect(clipStatusText("unreadable")).toBe("Needs a person to read it");
    expect(agreementText({ result: "matches", arrivalMinutesOff: 0, departureMinutesOff: 2 })).toBe(
      "Matches the stored stop times",
    );
    expect(agreementText({ result: "differs", arrivalMinutesOff: 1, departureMinutesOff: 61 })).toBe(
      "Differs from the stored stop times (departure 61 minutes off)",
    );
    expect(agreementText({ result: "no_clock", arrivalMinutesOff: null, departureMinutesOff: null })).toBe(
      "No camera clock was read",
    );
    expect(agreementText({ result: "no_times", arrivalMinutesOff: null, departureMinutesOff: null })).toBe(
      "No stored stop time to compare with",
    );
    expect(CLIP_STOPS).toEqual(["pickup", "delivery"]);
  });

  it("writes clip times as minutes and seconds", () => {
    expect(clipTime(0)).toBe("0:00");
    expect(clipTime(4.9)).toBe("0:04");
    expect(clipTime(75)).toBe("1:15");
    expect(clipTime(-3)).toBe("0:00");
  });
});
