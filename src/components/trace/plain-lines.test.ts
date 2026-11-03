import { describe, expect, it } from "vitest";
import { SAMPLE_PROPOSAL_ID, sampleTrace } from "@/lib/trace/sample";
import { traceLines } from "@/lib/trace/format";
import { plainLines } from "./plain-lines";

describe("plainLines", () => {
  it("keeps the steps that read or saved something, with no who, time, cost or effort", () => {
    const trace = sampleTrace();
    const rows = plainLines(trace);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(traceLines(trace).length);
    for (const row of rows) {
      expect(row.who).toBe("");
      expect(row.meta).toEqual([]);
      expect(row.effort).toBeUndefined();
      expect(row.cache).toBeUndefined();
      expect(row.text).not.toMatch(/Muse|cents?\b|model time/);
    }
    const kinds = new Map(trace.steps.map((s) => [`step:${s.seq}`, s.kind]));
    const modelRows = rows.filter((r) => kinds.get(r.key) === "model");
    for (const row of modelRows) expect(row.text).toBe("One step did not finish.");
  });

  it("says the second check in words, with no badge", () => {
    const rows = plainLines(sampleTrace(), SAMPLE_PROPOSAL_ID);
    const check = rows.find((r) => /:auditor$/.test(r.key));
    expect(check?.text).toBe("Second check agreed.");
    expect(check?.badge).toBeNull();
  });

  it("returns no rows when only model steps ran", () => {
    const trace = sampleTrace();
    const quiet = { ...trace, steps: trace.steps.filter((s) => s.kind === "model"), extraCalls: [], proposals: [] };
    expect(plainLines(quiet)).toEqual([]);
  });
});
