import { describe, expect, it } from "vitest";
import { overCap, type Spend } from "./spend";

// The cap test the reserve makes under its lock, alone: no database. The ledger's own behavior
// around it (the lock, the rows it writes) is in spend.db.test.ts.

const SPEND: Spend = {
  spentNanocents: 600,
  reservedNanocents: 300,
  calls: 4,
  wonderSpentNanocents: 100,
  wonderReservedNanocents: 50,
};

describe("overCap", () => {
  it("lets a reservation fill the overall cap exactly and refuses one nanocent more", () => {
    const r = { target: "spark" as const, capNanocents: 1_000, wonderCapNanocents: null };
    expect(overCap(SPEND, { ...r, reserveNanocents: 100 })).toBe(false);
    expect(overCap(SPEND, { ...r, reserveNanocents: 101 })).toBe(true);
    // What is reserved counts as much as what is spent.
    expect(overCap({ ...SPEND, spentNanocents: 0, reservedNanocents: 1_000 }, { ...r, reserveNanocents: 1 })).toBe(true);
  });

  it("holds Wonder to its own cap inside the overall one, and only Wonder", () => {
    const wonder = { target: "wonder" as const, capNanocents: 1_000, wonderCapNanocents: 200 };
    expect(overCap(SPEND, { ...wonder, reserveNanocents: 50 })).toBe(false);
    expect(overCap(SPEND, { ...wonder, reserveNanocents: 51 })).toBe(true);
    // The overall cap still binds Wonder.
    expect(overCap(SPEND, { ...wonder, wonderCapNanocents: 10_000, reserveNanocents: 101 })).toBe(true);
    // A missing Wonder cap refuses Wonder.
    expect(overCap(SPEND, { ...wonder, wonderCapNanocents: null, reserveNanocents: 1 })).toBe(true);
    // Any other target ignores the Wonder figures.
    expect(overCap(SPEND, { target: "spark", capNanocents: 1_000, wonderCapNanocents: 1, reserveNanocents: 100 })).toBe(
      false,
    );
  });
});
