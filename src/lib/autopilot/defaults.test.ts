import { describe, expect, it } from "vitest";
import { autoAllowed, isNeverAloneKind } from "../money/never-alone";
import { DEFAULT_RULES } from "./defaults";

// The starting rules never set a kind a person must approve to Auto (0077 would refuse the row).
describe("DEFAULT_RULES", () => {
  it("sets Auto only on allowed kinds, never on a never-alone kind", () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
    for (const r of DEFAULT_RULES) {
      expect(isNeverAloneKind(r.kind), r.kind).toBe(false);
      if (r.mode === "auto") expect(autoAllowed(r.kind), r.kind).toBe(true);
    }
  });
});
