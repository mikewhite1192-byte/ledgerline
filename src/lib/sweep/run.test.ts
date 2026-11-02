import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { maxDuration as internalLimitS } from "../../app/api/internal/sweep/route";
import { maxDuration as advanceLimitS } from "../../app/api/sweeps/[id]/advance/route";
import { maxDuration as startLimitS } from "../../app/api/sweeps/route";
import { flags } from "../../config/flags";
import { EXPLAIN_TIMEOUT_MS } from "../agent/sweep/explain";
import {
  DRAFT_LEASE_S,
  DRAFT_STEP_OVERRUN_MS,
  earlierOutcome,
  MAX_DRAFT_ATTEMPTS,
  openPeriod,
  STOP_BEFORE_MS,
  TRANSIENT_REFUSALS,
} from "./run";

// The draft lease covers the worst draft step. A slice's deadline is set before its lease is
// taken, so the lease starts at most sliceMs before that deadline; a step may start just over
// STOP_BEFORE_MS before it, the gateway stops by it, and the explanation and the last writes may
// run DRAFT_STEP_OVERRUN_MS past it.
describe("the sweep's draft lease", () => {
  it("outlasts the worst draft step: the whole slice plus the explanation and its writes", () => {
    expect(DRAFT_STEP_OVERRUN_MS).toBeGreaterThan(EXPLAIN_TIMEOUT_MS);
    expect(flags.sweepLimits.sliceMs + DRAFT_STEP_OVERRUN_MS).toBeLessThan(DRAFT_LEASE_S * 1000);
    expect(STOP_BEFORE_MS).toBeLessThan(flags.sweepLimits.sliceMs);
  });

  it("outlasts every route that carries a slice, so no step outlives it while its request is alive", () => {
    for (const limit of [startLimitS, advanceLimitS, internalLimitS]) {
      expect(limit * 1000).toBeLessThan(DRAFT_LEASE_S * 1000);
    }
  });
});

describe("the sweep's draft retries", () => {
  it("retries only refusals that say nothing about the fix, a bounded number of times", () => {
    expect([...TRANSIENT_REFUSALS].sort()).toEqual(
      ["budget", "limit_unavailable", "screen_error", "tool_failed", "turn_unavailable"].sort(),
    );
    for (const lasting of ["amount_over_limit", "engine_refused", "invalid_args", "unknown_record", "no_draft"]) {
      expect(TRANSIENT_REFUSALS as readonly string[]).not.toContain(lasting);
    }
    expect(Number.isSafeInteger(MAX_DRAFT_ATTEMPTS) && MAX_DRAFT_ATTEMPTS > 1).toBe(true);
  });
});

describe("an earlier fix's outcome", () => {
  it("names a done fix fixed, an undecided one expired, and a turned-down one declined", () => {
    expect(earlierOutcome("done")).toBe("fixed_earlier");
    expect(earlierOutcome("expired")).toBe("expired_earlier");
    expect(earlierOutcome("rejected")).toBe("declined_earlier");
    expect(earlierOutcome("failed")).toBe("declined_earlier");
  });
});

// A stand-in for the periods table: it keeps the open row the SQL names, one row. The week picked
// when none is named (readDueWeek) reads against the real database (roll.db.test.ts).
function periodsDb(rows: { id: string; period_start: string; status: string }[]): Queryable {
  return {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      expect(sql).toMatch(/status = 'open' AND id = CAST\(\$1 AS uuid\)/);
      return rows
        .filter((r) => r.status === "open" && r.id === params[0])
        .map((r) => ({ id: r.id, period_start: r.period_start, period_end: r.period_start })) as T[];
    },
    async execute() {
      throw new Error("openPeriod writes nothing");
    },
  };
}

describe("the run's open week", () => {
  const rows = [
    { id: "w-paid", period_start: "2026-10-19", status: "paid" },
    { id: "w-old", period_start: "2026-10-26", status: "open" },
    { id: "w-new", period_start: "2026-11-02", status: "open" },
  ];

  it("is the named week while it is open, and none when the named week is not open", async () => {
    expect((await openPeriod(periodsDb(rows), "w-old"))?.id).toBe("w-old");
    expect((await openPeriod(periodsDb(rows), "w-new"))?.id).toBe("w-new");
    expect(await openPeriod(periodsDb(rows), "w-paid")).toBeNull();
  });
});
