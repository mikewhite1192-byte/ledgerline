import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { shouldFallBack, standbyFor } from "./standby";
import type { AiFailureCategory } from "./types";

const CATEGORIES: AiFailureCategory[] = [
  "rate_limited",
  "unavailable",
  "timeout",
  "bad_request",
  "auth",
  "billing",
  "too_long",
  "network",
  "unknown",
];

afterEach(() => {
  flags.sparkOpenFallback = "off";
});

describe("shouldFallBack", () => {
  it("falls back when nothing was sent", () => {
    expect(shouldFallBack({ kind: "not_sent" })).toBe(true);
  });

  it("never falls back after an answer, complete or not", () => {
    for (const status of ["ok", "incomplete"] as const) {
      expect(
        shouldFallBack({
          kind: "answered",
          status,
          httpStatus: 200,
          upstreamId: null,
          metered: { unit: "tokens", usage: { input: 1, cached: 0, output: 1, reasoning: 0 } },
          value: { text: "", toolCalls: [], replay: [] },
        }),
      ).toBe(false);
    }
  });

  it("falls back after a refusal only for the host's limits, key or billing", () => {
    const yes = CATEGORIES.filter((category) =>
      shouldFallBack({ kind: "refused", category, httpStatus: 400 }),
    );
    expect(yes).toEqual(["rate_limited", "auth", "billing"]);
  });

  it("falls back after an unknown outcome only for a dropped connection, a 5xx or a 403", () => {
    const yes = CATEGORIES.filter((category) =>
      shouldFallBack({ kind: "unknown", category, httpStatus: null }),
    );
    // Never a timeout (or 504), an unreadable 200, or any other status.
    expect(yes).toEqual(["unavailable", "auth", "network"]);
  });
});

describe("standbyFor", () => {
  it("names Fireworks for Muse Spark Open only while the switch names it", () => {
    expect(standbyFor("spark_open")).toBeNull();
    flags.sparkOpenFallback = "fireworks";
    expect(standbyFor("spark_open")).toBe("fireworks");
  });

  it("never names a standby for a Meta target, switch on or off", () => {
    for (const setting of ["off", "fireworks"] as const) {
      flags.sparkOpenFallback = setting;
      for (const target of ["spark", "wonder", "voice", "image", "sam"] as const) {
        expect(standbyFor(target), `${target} ${setting}`).toBeNull();
      }
    }
  });
});
