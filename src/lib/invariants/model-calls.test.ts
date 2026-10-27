import { describe, expect, it } from "vitest";
import { MODEL_CALLS_SQL, STALE_RESERVED_MINUTES, judgeModelCalls, type ModelCallsRow } from "./model-calls";

function clean(): ModelCallsRow {
  return {
    counter_rows: 1,
    counter_spent: "120000000",
    counter_reserved: "5000000",
    counter_calls: 4,
    counter_wonder_spent: "20000000",
    counter_wonder_reserved: 0,
    calls_logged: 5,
    answered_without_cost: 0,
    text_without_tokens: 0,
    stale_reserved: 0,
    spent: "120000000",
    reserved: "5000000",
    settled: 4,
    wonder_spent: "20000000",
    wonder_reserved: "0",
  };
}

describe("judgeModelCalls", () => {
  it("passes when every call is costed and the counters equal the log", () => {
    const r = judgeModelCalls([clean()]);
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ calls: 5, settled: 4 });
  });

  it("catches an answered call with no cost or no tokens, and a reservation left behind", () => {
    const row = { ...clean(), answered_without_cost: 1, text_without_tokens: 2, stale_reserved: 1 };
    expect(judgeModelCalls([row]).violations).toEqual({
      answered_without_cost: 1,
      text_without_tokens: 2,
      stale_reserved: 1,
    });
  });

  it("catches each counter that drifted from the log, by one nanocent", () => {
    const cases: [Partial<ModelCallsRow>, string][] = [
      [{ counter_spent: "120000001" }, "counter_off:spent"],
      [{ counter_reserved: "4999999" }, "counter_off:reserved"],
      [{ counter_calls: 5 }, "counter_off:calls"],
      [{ counter_wonder_spent: "20000001" }, "counter_off:wonder_spent"],
      [{ counter_wonder_reserved: 1 }, "counter_off:wonder_reserved"],
    ];
    for (const [change, category] of cases) {
      expect(judgeModelCalls([{ ...clean(), ...change }]).violations).toEqual({ [category]: 1 });
    }
  });

  it("treats a missing counter row or an unreadable value as unread, never as zero", () => {
    expect(() => judgeModelCalls([])).toThrow("model_calls_unread");
    expect(() => judgeModelCalls([{ ...clean(), counter_rows: 0 }])).toThrow("spend_counter_missing");
    expect(() => judgeModelCalls([{ ...clean(), counter_spent: null }])).toThrow("not_whole");
  });

  it("reads the counters and the log in one statement, against the database clock", () => {
    expect(MODEL_CALLS_SQL).toContain("FROM ops.ai_spend");
    expect(MODEL_CALLS_SQL).toContain(`now() - interval '${STALE_RESERVED_MINUTES} minutes'`);
    expect(MODEL_CALLS_SQL.trim().startsWith("SELECT")).toBe(true);
  });
});
