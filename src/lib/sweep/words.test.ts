import { describe, expect, it } from "vitest";
import { sweepOutcome } from "./words";

// The pay check's outcome line from fixed runs. Nothing reads the clock or a database.

const RUN = {
  status: "done" as const,
  trigger: "schedule",
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  counts: { found: 8, fixes_drafted: 5, needs_person: 3 },
};

describe("sweepOutcome on Home", () => {
  it("says what was checked, then what it found and drafted", () => {
    expect(sweepOutcome(RUN, "home")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. Found 8 mistakes and drafted fixes for 5.",
    );
    expect(sweepOutcome({ ...RUN, counts: { found: 1, fixes_drafted: 1 } }, "home")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. Found 1 mistake and drafted a fix for 1.",
    );
    expect(sweepOutcome({ ...RUN, counts: { found: 3, fixes_drafted: 0 } }, "home")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. Found 3 mistakes.",
    );
  });

  it("says no mistakes, a check still running, and one that stopped, never a 0", () => {
    expect(sweepOutcome({ ...RUN, counts: { found: 0, fixes_drafted: 0 } }, "home")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. No mistakes.",
    );
    expect(sweepOutcome({ ...RUN, counts: {} }, "home")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. No mistakes.",
    );
    expect(sweepOutcome({ ...RUN, status: "running" }, "home")).toBe(
      "Checking every driver's pay for the week of Oct 26 to Nov 1 now.",
    );
    expect(sweepOutcome({ ...RUN, status: "failed" }, "home")).toBe("The pay check stopped before it finished.");
  });

  it("falls back to this week when the run's dates do not read", () => {
    expect(sweepOutcome({ ...RUN, periodStart: "not a day" }, "home")).toBe(
      "Checked every driver's pay for this week. Found 8 mistakes and drafted fixes for 5.",
    );
  });
});

describe("sweepOutcome on the pay check page", () => {
  it("leads with what it found, says when it ran before anyone logged in, and what needs a person", () => {
    expect(sweepOutcome(RUN, "page")).toBe(
      "Found 8 pay mistakes before payday and drafted fixes for 5, before anyone logged in. 3 need you.",
    );
    expect(sweepOutcome({ ...RUN, trigger: "button", counts: { found: 1, fixes_drafted: 1, needs_person: 1 } }, "page")).toBe(
      "Found 1 pay mistake before payday and drafted a fix for 1. 1 needs you.",
    );
    expect(sweepOutcome({ ...RUN, counts: { found: 0 } }, "page")).toBe(
      "Checked every driver's pay for the week of Oct 26 to Nov 1. No mistakes.",
    );
    expect(sweepOutcome({ ...RUN, status: "failed" }, "page")).toBe("The last check stopped early. Run it again.");
  });
});
