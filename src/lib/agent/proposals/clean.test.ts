import { describe, expect, it } from "vitest";
import { CLEAN_SQL, isClean, type CleanFields } from "./clean";

// Only a pass joins Approve all clean (design 4.2 step 5): concerns, block, unknown and no verdict
// are never clean, and neither the verdict nor the agreement alone lets a row in.

const base: CleanFields = {
  status: "proposed",
  exceptions: [],
  flaggedInputId: null,
  auditorVerdict: "pass",
  auditorAgrees: true,
};

describe("isClean", () => {
  it("is clean only for a waiting pass with no exception and no flag", () => {
    expect(isClean(base)).toBe(true);
  });

  it.each([
    ["concerns", false],
    ["block", false],
    ["unknown", null],
    [null, null],
  ] as const)("is never clean for verdict %s", (auditorVerdict, auditorAgrees) => {
    expect(isClean({ ...base, auditorVerdict, auditorAgrees })).toBe(false);
  });

  it("needs both the pass and the agreement", () => {
    expect(isClean({ ...base, auditorAgrees: null })).toBe(false);
    expect(isClean({ ...base, auditorVerdict: "concerns" })).toBe(false);
  });

  it("is not clean once decided, with an exception or with a flagged input", () => {
    expect(isClean({ ...base, status: "approved" })).toBe(false);
    expect(isClean({ ...base, exceptions: ["over_limit"] })).toBe(false);
    expect(isClean({ ...base, flaggedInputId: "9d1e2f3a-4b5c-4d6e-8f7a-1b2c3d4e5f60" })).toBe(false);
  });
});

describe("CLEAN_SQL", () => {
  it("keeps its name, its alias and every condition", () => {
    expect(CLEAN_SQL).toBe(
      "p.status = 'proposed' AND jsonb_array_length(p.exceptions) = 0 " +
        "AND p.flagged_input_id IS NULL AND p.auditor_verdict = 'pass' AND p.auditor_agrees IS TRUE",
    );
  });
});
