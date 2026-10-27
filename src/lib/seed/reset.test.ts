import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../data/tables";
import golden from "./golden.json";
import { DEMO_ANCHOR } from "./anchor";
import {
  CLEARED_TABLES,
  DEMO_RESET_CLEARED,
  DEMO_RESET_KEPT,
  DemoResetRefused,
  FUNCTION_TABLES,
  RESET_SQLSTATE,
  RESET_TABLES,
  TABLE_LABELS,
  refusalText,
} from "./reset";

describe("the demo reset's lists", () => {
  it("resets at the anchor the golden counts were built for", () => {
    expect(DEMO_ANCHOR).toBe(golden.anchor);
  });

  it("gives every table a reset decision in one list only, and a plain label to every one it changes", () => {
    const decided = [...TENANT_TABLES, ...Object.keys(DEMO_RESET_CLEARED), ...Object.keys(DEMO_RESET_KEPT)];
    expect(new Set(decided).size).toBe(decided.length);
    expect(Object.keys(TABLE_LABELS).sort()).toEqual([...RESET_TABLES].sort());
    for (const t of RESET_TABLES) expect(TABLE_LABELS[t].length, t).toBeGreaterThan(2);
    expect([...CLEARED_TABLES, "advances"].sort()).toEqual([...FUNCTION_TABLES].sort());
  });

  it("keeps the error codes the function raises", () => {
    expect(RESET_SQLSTATE).toEqual({ noTenant: "LR001", notDemo: "LR002", refused: "LR003" });
  });
});

describe("a refusal", () => {
  it("names counts only, and says nothing was cleared", () => {
    expect(refusalText({ kind: "open", count: 2 })).toBe(
      "2 ledger row(s) still reserved, sent or unknown; settle them before a reset",
    );
    expect(refusalText({ kind: "mismatch", count: 1 })).toBe(
      "1 ledger row(s) failed as amount_mismatch; a person must review them before a reset",
    );
    expect(refusalText({ kind: "flagged", count: 3 })).toBe(
      "3 proposal(s) a ledger row names carry a flag from an outside message; a person must review them before a reset",
    );
    const err = new DemoResetRefused([
      { kind: "open", count: 1 },
      { kind: "mismatch", count: 1 },
    ]);
    expect(err.message).toBe(
      "1 ledger row(s) still reserved, sent or unknown; settle them before a reset; " +
        "1 ledger row(s) failed as amount_mismatch; a person must review them before a reset " +
        "(nothing was cleared)",
    );
  });
});
