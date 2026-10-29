import { describe, expect, it } from "vitest";
import { uniqueViolationCategory } from "./execute";

// Which outcome a unique violation (23505) on the approval's code write becomes. Only the two
// live-evidence indexes, named whole, say the evidence is reused; everything else, a missing name
// included, stays a code collision.

describe("a unique violation on the money code write", () => {
  it("says the evidence is reused for the live document and voice note indexes", () => {
    expect(uniqueViolationCategory("money_codes_one_live_per_document")).toBe("evidence_reused");
    expect(uniqueViolationCategory("money_codes_one_live_per_voice_note")).toBe("evidence_reused");
  });

  it("keeps any other index, a near name and a missing name a code collision", () => {
    expect(uniqueViolationCategory("money_codes_one_per_proposal")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("money_codes_pkey")).toBe("code_ref_collision");
    // Whole names only: longer, shorter or differently cased is another constraint.
    expect(uniqueViolationCategory("money_codes_one_live_per_document_old")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("one_live_per_voice_note")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("MONEY_CODES_ONE_LIVE_PER_DOCUMENT")).toBe("code_ref_collision");
    expect(uniqueViolationCategory("")).toBe("code_ref_collision");
    // No constraint name read from the driver: fail closed.
    expect(uniqueViolationCategory(undefined)).toBe("code_ref_collision");
  });
});
