import { describe, expect, it } from "vitest";
import { MAX_RESULT_CHARS } from "../../index";
import { fitTmsResult, TMS_RESULT_ROOM, type FitList } from "./tms-fit";

// The dispatch tools cut their own lists to fit under the gateway's cap: the first list loses rows
// from its end before the next is touched, and each list says how many it left out.

const row = (i: number) => ({ id: i, note: "x".repeat(180) });
const listOf = (n: number, total = n): FitList => ({ rows: Array.from({ length: n }, (_, i) => row(i)), total, omitted: 0 });

describe("fitTmsResult", () => {
  it("leaves a result that fits alone, and counts rows the reader already capped", () => {
    const a = listOf(3, 25);
    const out = fitTmsResult({ status: "ok", a }, [a]);
    expect(a.rows).toHaveLength(3);
    expect(a.omitted).toBe(22);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TMS_RESULT_ROOM);
  });

  it("cuts the first list first, then the next, until the result fits under the cap", () => {
    const first = listOf(50);
    const second = listOf(50);
    const out = fitTmsResult({ status: "ok", first, second }, [first, second]);
    const chars = JSON.stringify(out).length;
    expect(TMS_RESULT_ROOM).toBeLessThan(MAX_RESULT_CHARS);
    expect(chars).toBeLessThanOrEqual(TMS_RESULT_ROOM);
    expect(first.rows).toHaveLength(0);
    expect(first.omitted).toBe(50);
    expect(second.rows.length).toBeGreaterThan(0);
    expect(second.omitted).toBe(50 - second.rows.length);
    // Keeping the kept rows in order, one more row would not have fit.
    expect(second.rows.map((r) => (r as { id: number }).id)).toEqual(second.rows.map((_, i) => i));
    second.rows.push(row(second.rows.length));
    expect(JSON.stringify(out).length).toBeGreaterThan(TMS_RESULT_ROOM);
  });

  it("stops at empty lists when nothing else can be cut", () => {
    const a = listOf(2);
    const out = fitTmsResult({ big: "y".repeat(9_000), a }, [a]);
    expect(a.rows).toEqual([]);
    expect(a.omitted).toBe(2);
    expect(JSON.stringify(out).length).toBeGreaterThan(TMS_RESULT_ROOM);
  });
});
