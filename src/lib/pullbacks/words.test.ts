import { describe, expect, it } from "vitest";
import { OUTCOME_FALLBACK } from "../invoices/labels";
import { PULL_APPROVE_NOTICES, PULL_FOR_PERSON } from "./words";

// The advance page's pull-back card says a pull confirmed at another amount in its own words, so
// an approval that moved money never reads as nothing changed.
describe("the pull-back card's notices", () => {
  it("says a pull left unknown waits for a person, never that nothing changed", () => {
    expect(PULL_APPROVE_NOTICES.pull_unknown).toBe(PULL_FOR_PERSON);
    expect(PULL_FOR_PERSON).toBe(
      "The card may have given back a different amount than planned, so this is not confirmed. A person settles it, and nothing is pulled again.",
    );
    expect(PULL_FOR_PERSON).not.toContain("Nothing changed");
    expect(PULL_FOR_PERSON).not.toBe(OUTCOME_FALLBACK);
    // Only the outcome the shared sentences say wrongly; the rest stay theirs.
    expect(Object.keys(PULL_APPROVE_NOTICES)).toEqual(["pull_unknown"]);
  });
});
