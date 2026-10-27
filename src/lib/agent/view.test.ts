import { describe, expect, it } from "vitest";
import { turnErrorFor } from "./view";

// Which error state the chat shows for a failed turn, from the reason it ended.

describe("turnErrorFor", () => {
  it("shows the budget, the stopped job and the timeout states, and unknown for the rest", () => {
    expect(turnErrorFor("failed", "budget")).toBe("budget");
    expect(turnErrorFor("failed", "job_cap")).toBe("job_cap");
    expect(turnErrorFor("failed", "clock")).toBe("timeout");
    expect(turnErrorFor("failed", "model_timeout")).toBe("timeout");
    expect(turnErrorFor("failed", "job")).toBe("unknown");
    expect(turnErrorFor("failed", null)).toBe("unknown");
  });

  it("shows no error for a turn that did not fail", () => {
    for (const status of ["running", "done", "partial"] as const) {
      expect(turnErrorFor(status, "job_cap")).toBeNull();
    }
  });
});
