import { describe, expect, it } from "vitest";
import { IFTA_RATE_MAX_MCENTS, IFTA_RATE_MIN_MCENTS } from "../lib/rules-engine/ifta";
import { IFTA_SAMPLE_LABEL, IFTA_SAMPLE_RATES } from "./ifta-sample-rates";

// The sample table is a placeholder for every contiguous state, labeled SAMPLE wherever it shows.

describe("IFTA sample rates", () => {
  it("has one rate for each of the 48 contiguous states, each distinct and in range", () => {
    expect(IFTA_SAMPLE_RATES).toHaveLength(48);
    const states = IFTA_SAMPLE_RATES.map((r) => r.state);
    expect(new Set(states).size).toBe(48);
    expect(states).not.toContain("AK");
    expect(states).not.toContain("HI");
    expect(new Set(IFTA_SAMPLE_RATES.map((r) => r.rateMcents)).size).toBe(48);
    for (const r of IFTA_SAMPLE_RATES) {
      expect(r.state, r.state).toMatch(/^[A-Z]{2}$/);
      expect(Number.isSafeInteger(r.rateMcents), r.state).toBe(true);
      expect(r.rateMcents, r.state).toBeGreaterThanOrEqual(Math.max(IFTA_RATE_MIN_MCENTS, 15_000));
      expect(r.rateMcents, r.state).toBeLessThanOrEqual(Math.min(IFTA_RATE_MAX_MCENTS, 60_000));
      // The CSV shows a rate in dollars to four places, so a rate must be whole hundredths of a cent.
      expect(r.rateMcents % 10, r.state).toBe(0);
    }
  });

  it("is labeled SAMPLE", () => {
    expect(IFTA_SAMPLE_LABEL).toBe("SAMPLE");
  });
});
