import { describe, expect, it } from "vitest";
import { isNeverAloneKind } from "../money/never-alone";
import { DEFAULT_RULES } from "./defaults";
import { autoOffered } from "./rules-admin";

// The starting rules never set a kind a person must approve to Auto (0077 would refuse the row),
// nor one the owner could not set to Auto from the app (a card match).
describe("DEFAULT_RULES", () => {
  it("sets Auto only on kinds the app offers it on, never on a never-alone kind", () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
    for (const r of DEFAULT_RULES) {
      expect(isNeverAloneKind(r.kind), r.kind).toBe(false);
      if (r.mode === "auto") expect(autoOffered(r.kind), r.kind).toBe(true);
    }
  });
});
