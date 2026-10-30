import { afterEach, describe, expect, it, vi } from "vitest";
import { NANOCENTS_PER_CENT } from "../../src/lib/ai/prices";
import type { Spend } from "../../src/lib/ai/spend";
import { armSpendOf, CARRY_SQL, carrySpend, settleArmSpend } from "./eval-spend";

const N = NANOCENTS_PER_CENT;
const spend = (over: Partial<Spend> = {}): Spend => ({
  spentNanocents: 0,
  reservedNanocents: 0,
  calls: 0,
  wonderSpentNanocents: 0,
  wonderReservedNanocents: 0,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("an eval arm's spend", () => {
  it("counts an open reservation as spent, overall and on the second check's column", () => {
    expect(armSpendOf(spend({ spentNanocents: 5 * N, reservedNanocents: 2 * N, wonderSpentNanocents: N, wonderReservedNanocents: 3 }))).toEqual({
      nanocents: 7 * N,
      wonderNanocents: N + 3,
    });
  });

  it("is added to the local ledger's one row in a single statement", async () => {
    const calls: { sql: string; params: unknown[] | undefined }[] = [];
    const q = {
      execute: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return 1;
      },
    };
    await carrySpend(q, { nanocents: 1_234 * N, wonderNanocents: 56 });
    expect(calls).toEqual([{ sql: CARRY_SQL, params: [1_234 * N, 56] }]);
    expect(CARRY_SQL).toMatch(/^UPDATE ops\.ai_spend SET /);
    expect(CARRY_SQL).toMatch(/WHERE id = 1$/);
  });

  it("fails when the row is not there, and refuses an amount that is not whole and non-negative", async () => {
    const none = { execute: async () => 0 };
    await expect(carrySpend(none, { nanocents: 1, wonderNanocents: 0 })).rejects.toThrow();
    const execute = vi.fn(async () => 1);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(carrySpend({ execute }, { nanocents: bad, wonderNanocents: 0 })).rejects.toThrow();
      await expect(carrySpend({ execute }, { nanocents: 0, wonderNanocents: bad })).rejects.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("is carried and logged in one line with the arm and its cents", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const carry = vi.fn(async () => {});
    const r = await settleArmSpend("wonder", 300, {
      read: async () => spend({ spentNanocents: 1_250 * N, reservedNanocents: 0, wonderSpentNanocents: 400 * N }),
      carry,
    });
    expect(r).toEqual({ spentNanocents: 1_250 * N, carried: true });
    expect(carry).toHaveBeenCalledWith({ nanocents: 1_250 * N, wonderNanocents: 400 * N });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe("eval: added 1250.00 cents from the wonder arm to the local spend ledger");
  });

  it("an arm ledger that cannot be read is carried, and counted, as the whole allowance", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const carry = vi.fn(async () => {});
    const r = await settleArmSpend("spark", 80, {
      read: async () => {
        throw new Error("gone");
      },
      carry,
    });
    expect(r).toEqual({ spentNanocents: 80 * N, carried: true });
    expect(carry).toHaveBeenCalledWith({ nanocents: 80 * N, wonderNanocents: 80 * N });
  });

  it("a carry that fails counts the whole allowance and says it was not carried", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await settleArmSpend("spark_open", 120, {
      read: async () => spend({ spentNanocents: 7 * N }),
      carry: async () => {
        throw new Error("connection refused");
      },
    });
    expect(r).toEqual({ spentNanocents: 120 * N, carried: false });
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("spark_open");
    expect(String(error.mock.calls[0][0])).not.toContain("connection refused");
  });
});
