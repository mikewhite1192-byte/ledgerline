import { describe, expect, it } from "vitest";
import { namedDriver, plainWhy, sweepOutcome } from "./words";

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

describe("plainWhy", () => {
  const why = "The engine found a duplicate advance for driver BR-D17 for the week 2026-10-26 to 2026-11-01.";

  it("says the week in plain dates and names the driver whose code is on the item", () => {
    expect(plainWhy(why, { code: "BR-D17", name: "Marcus Calloway" })).toBe(
      "The engine found a duplicate advance for driver Marcus Calloway for the week Oct 26 to Nov 1, 2026.",
    );
  });

  it("keeps the code when no name is on file, and changes only the dates", () => {
    expect(plainWhy(why, { code: "BR-D17", name: null })).toBe(
      "The engine found a duplicate advance for driver BR-D17 for the week Oct 26 to Nov 1, 2026.",
    );
  });

  it("replaces only the whole code, never a longer code that starts with it or another driver's", () => {
    const text = "Compare BR-D17 with BR-D170 and BR-D17-X and xBR-D17.";
    expect(plainWhy(text, { code: "BR-D17", name: "Marcus Calloway" })).toBe(
      "Compare Marcus Calloway with BR-D170 and BR-D17-X and xBR-D17.",
    );
    expect(plainWhy(why, { code: "BR-D07", name: "Dana Reyes" })).toContain("driver BR-D17 for");
  });

  it("leaves the code when the name is already in the text, and keeps the year when a range crosses one", () => {
    expect(plainWhy("Marcus Calloway (BR-D17) was paid twice.", { code: "BR-D17", name: "Marcus Calloway" })).toBe(
      "Marcus Calloway (BR-D17) was paid twice.",
    );
    expect(plainWhy("From 2026-12-28 to 2027-01-03.", { code: null, name: null })).toBe("From Dec 28, 2026 to Jan 3, 2027.");
  });
});

describe("namedDriver", () => {
  it("names the driver in a set-aside item's note, and leaves it when no name is on file", () => {
    const note = "Advances for BR-D16 are $150.00 over the driver's limit.";
    expect(namedDriver(note, { code: "BR-D16", name: "Andre Gutierrez" })).toBe(
      "Advances for Andre Gutierrez are $150.00 over the driver's limit.",
    );
    expect(namedDriver(note, { code: "BR-D16", name: null })).toBe(note);
    expect(namedDriver(note, { code: "BR-D1", name: "Dana Reyes" })).toBe(note);
  });
});
