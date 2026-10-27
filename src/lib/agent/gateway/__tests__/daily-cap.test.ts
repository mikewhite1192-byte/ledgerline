import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../../config/flags";
import type { Queryable } from "../../../db";
import { advanceDailyCap, isOverDailyCap } from "../daily-cap";
import type { GatewayContext } from "../types";

// The ceiling on advance proposals per tenant per local day: one more is refused at the ceiling,
// a broken ceiling or count blocks, and an unreadable count is limit_unavailable, never zero.

const saved = structuredClone(flags.advancesLimits);
const ctx = { now: new Date(Date.UTC(2026, 10, 2, 16)) } as GatewayContext;

function countOf(rows: unknown[] | Error): Queryable & { params: unknown[][] } {
  const params: unknown[][] = [];
  return {
    params,
    async query<T>(_sql: string, p?: unknown[]): Promise<T[]> {
      params.push(p ?? []);
      if (rows instanceof Error) throw rows;
      return rows as T[];
    },
    async execute() {
      return 0;
    },
  };
}

afterEach(() => {
  flags.advancesLimits = structuredClone(saved);
  vi.restoreAllMocks();
});

describe("the advance proposal ceiling", () => {
  it("refuses one more at the ceiling, never below it", () => {
    expect(isOverDailyCap(29, 30)).toBe(false);
    expect(isOverDailyCap(30, 30)).toBe(true);
    expect(isOverDailyCap(0, 0)).toBe(true);
  });

  it("treats a broken ceiling or count as reached", () => {
    expect(isOverDailyCap(0, Number.NaN)).toBe(true);
    expect(isOverDailyCap(0, -1)).toBe(true);
    expect(isOverDailyCap(0, 2.5)).toBe(true);
    expect(isOverDailyCap(Number.NaN, 30)).toBe(true);
    expect(isOverDailyCap(-1, 30)).toBe(true);
  });

  it("asks the count for the call's instant and lets the engine decide under the ceiling", async () => {
    const q = countOf([{ n: "3" }]);
    expect(await advanceDailyCap(q, ctx, 25_000)).toBeNull();
    expect(q.params).toEqual([["2026-11-02T16:00:00.000Z"]]);
  });

  it("blocks at the ceiling as budget", async () => {
    flags.advancesLimits = { ...flags.advancesLimits, proposalsPerDay: 3 };
    expect(await advanceDailyCap(countOf([{ n: 3 }]), ctx, 25_000)).toEqual({
      ok: false,
      reason: "budget",
      limitCents: null,
      requestedCents: 25_000,
    });
  });

  it("blocks an unreadable count as limit_unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const q of [countOf(new Error("down")), countOf([]), countOf([{ n: "many" }])]) {
      expect(await advanceDailyCap(q, ctx, 25_000)).toMatchObject({ ok: false, reason: "limit_unavailable" });
    }
  });
});
