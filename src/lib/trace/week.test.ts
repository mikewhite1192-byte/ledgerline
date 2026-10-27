import { describe, expect, it } from "vitest";
import type { WeekRaw } from "./types";
import { summarizeModelWeek } from "./week";

const WEEK = { start: "2026-10-26", end: "2026-11-01", zone: "America/Chicago" };

const empty: WeekRaw = { week: WEEK, groups: [], latencies: [], decisions: [], screenings: [], escalations: 0 };

const group = (over: Partial<WeekRaw["groups"][number]>): WeekRaw["groups"][number] => ({
  target: "spark",
  model: "muse-spark-1.3",
  status: "ok",
  calls: 1,
  costNanocents: 0,
  heldNanocents: 0,
  unsettled: 0,
  inputTokens: 0,
  cachedTokens: 0,
  savedNanocents: 0,
  ...over,
});

describe("summarizeModelWeek", () => {
  it("shows the three core models with zeros for an empty week, and nothing else", () => {
    const w = summarizeModelWeek(empty);
    expect(w.models.map((m) => m.name)).toEqual(["Muse Spark", "Muse Wonder", "Muse Spark Open"]);
    expect(w.models.every((m) => m.calls === 0 && m.costNanocents === 0 && m.p50Ms === null)).toBe(true);
    expect(w.calls).toBe(0);
    expect(w.costNanocents).toBe(0);
    expect(w.decisions.total).toBe(0);
    expect(w.screenings.total).toBe(0);
    expect(w.week).toEqual(WEEK);
  });

  it("sums calls and whole nanocents per model by status, and keeps the medians", () => {
    const w = summarizeModelWeek({
      ...empty,
      groups: [
        group({ status: "ok", calls: 7, costNanocents: 4_900_000_001 }),
        group({ status: "incomplete", calls: 1, costNanocents: 700_000_000 }),
        group({ status: "failed", calls: 2, costNanocents: 0 }),
        group({ status: "reserved", calls: 1, heldNanocents: 900_000_000, unsettled: 1 }),
        group({ model: "muse-spark-1.3-contributor", calls: 1, costNanocents: 1 }),
        group({ target: "wonder", model: "muse-wonder-1.0", calls: 2, costNanocents: 11_600_000_000 }),
        group({ target: "voice", model: "muse-voice", calls: 3, costNanocents: 30 }),
      ],
      latencies: [
        { target: "spark", p50Ms: 1_840 },
        { target: "wonder", p50Ms: 4_100 },
      ],
    });
    const spark = w.models[0];
    expect(spark).toMatchObject({
      calls: 12,
      ok: 8,
      incomplete: 1,
      failed: 2,
      pending: 1,
      costNanocents: 5_600_000_002,
      heldNanocents: 900_000_000,
      unsettled: 1,
      p50Ms: 1_840,
      versions: ["Muse Spark 1.3"],
    });
    expect(w.models.map((m) => m.target)).toEqual(["spark", "wonder", "spark_open", "voice"]);
    expect(w.calls).toBe(17);
    expect(w.costNanocents).toBe(5_600_000_002 + 11_600_000_000 + 30);
    expect(Number.isSafeInteger(w.costNanocents)).toBe(true);
  });

  it("puts a model it does not know under Other model, with no merged median", () => {
    const w = summarizeModelWeek({
      ...empty,
      groups: [
        group({ target: "llama", model: "llama-9", calls: 2 }),
        group({ target: "qwen", model: "qwen-3", calls: 1 }),
      ],
      latencies: [
        { target: "llama", p50Ms: 500 },
        { target: "qwen", p50Ms: 900 },
      ],
    });
    const other = w.models.at(-1);
    expect(other).toMatchObject({ target: "other", name: "Other model", calls: 3, p50Ms: null, versions: ["Other model"] });
  });

  it("counts gateway decisions and screenings in their buckets", () => {
    const w = summarizeModelWeek({
      ...empty,
      decisions: [
        { decision: "allowed", count: 9 },
        { decision: "blocked", count: 2 },
        { decision: "invalid_args", count: 1 },
        { decision: "denied", count: 1 },
        { decision: "failed", count: 1 },
      ],
      screenings: [
        { verdict: "clean", via: "model", count: 4 },
        { verdict: "clean", via: "cache", count: 2 },
        { verdict: "flagged", via: "pattern", count: 1 },
        { verdict: "flagged", via: "error", count: 1 },
      ],
      escalations: 3,
    });
    expect(w.decisions).toEqual({ allowed: 9, blocked: 2, refused: 2, failed: 1, total: 14 });
    expect(w.screenings).toEqual({ clean: 6, flagged: 2, byModel: 4, byCache: 2, byPattern: 1, errored: 1, total: 8 });
    expect(w.escalations).toBe(3);
  });

  it("refuses a figure that is not a whole number instead of reading it as zero", () => {
    expect(() => summarizeModelWeek({ ...empty, groups: [group({ costNanocents: Number.NaN })] })).toThrow(RangeError);
    expect(() => summarizeModelWeek({ ...empty, groups: [group({ calls: 1.5 })] })).toThrow(RangeError);
    expect(() => summarizeModelWeek({ ...empty, escalations: Number.NaN })).toThrow(RangeError);
  });

  it("sums cached and input tokens per model, floors the share, and keeps an unknown saving unknown", () => {
    const week = summarizeModelWeek({
      ...empty,
      groups: [
        group({ calls: 3, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000 }),
        group({ status: "incomplete", calls: 1, inputTokens: 1_000, cachedTokens: 0, savedNanocents: 0 }),
        group({ target: "wonder", model: "muse-wonder-1.0", calls: 1, inputTokens: 500, cachedTokens: 100, savedNanocents: 100 * 380_000 }),
        group({ target: "sam", model: "sam-3.1", calls: 1, inputTokens: 0, cachedTokens: 0, savedNanocents: null }),
      ],
    });
    const spark = week.models.find((m) => m.target === "spark")!;
    expect(spark).toMatchObject({ inputTokens: 3_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000, cachedShare: 54 });
    expect(week.models.find((m) => m.target === "wonder")).toMatchObject({ cachedShare: 20, savedNanocents: 38_000_000 });
    // A model with no token counts has no share, and a null saving with nothing cached adds 0.
    expect(week.models.find((m) => m.target === "sam")).toMatchObject({ cachedShare: null, savedNanocents: 0 });
    expect(week).toMatchObject({ inputTokens: 3_980, cachedTokens: 2_012, savedNanocents: 1_912 * 110_000 + 38_000_000, cachedShare: 50 });
    expect(summarizeModelWeek(empty)).toMatchObject({ inputTokens: 0, cachedTokens: 0, savedNanocents: 0, cachedShare: null });

    const unknown = summarizeModelWeek({ ...empty, groups: [group({ inputTokens: 100, cachedTokens: 50, savedNanocents: null })] });
    expect(unknown.models[0].savedNanocents).toBeNull();
    expect(unknown.savedNanocents).toBeNull();
  });

  it("refuses token sums that are not whole numbers", () => {
    expect(() => summarizeModelWeek({ ...empty, groups: [group({ inputTokens: Number.NaN })] })).toThrow(RangeError);
    expect(() => summarizeModelWeek({ ...empty, groups: [group({ inputTokens: 10, cachedTokens: 5, savedNanocents: 1.5 })] })).toThrow(RangeError);
  });

  it("makes the saving unknown for counts that do not fit together, and keeps the rest of the week", () => {
    const week = summarizeModelWeek({
      ...empty,
      groups: [
        group({ calls: 2, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000 }),
        group({ status: "incomplete", calls: 1, inputTokens: 10, cachedTokens: 11, savedNanocents: 11 * 110_000 }),
        group({ target: "wonder", model: "muse-wonder-1.0", calls: 1, inputTokens: 500, cachedTokens: 100, savedNanocents: 100 * 380_000 }),
      ],
    });
    const spark = week.models.find((m) => m.target === "spark");
    // The calls still count; the impossible pair stays out of the token sums.
    expect(spark).toMatchObject({ calls: 3, inputTokens: 2_480, cachedTokens: 1_912, cachedShare: 77, savedNanocents: null });
    expect(week.models.find((m) => m.target === "wonder")).toMatchObject({ savedNanocents: 38_000_000 });
    expect(week).toMatchObject({ inputTokens: 2_980, cachedTokens: 2_012, savedNanocents: null });
  });
});
