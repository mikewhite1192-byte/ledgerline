import { describe, expect, it } from "vitest";
import { cardFateOf } from "./service";

// What a proposed row's card leaves it. Only an expired or failed card is followed by a new one,
// a rejected card ends the row, and anything else (unknown included) is left live, so nothing is
// ever made from a status the code does not know.

describe("cardFateOf", () => {
  it("keeps a waiting, approved, running or done card live", () => {
    for (const status of ["proposed", "approved", "executing", "done"]) expect(cardFateOf(status)).toBe("live");
  });

  it("takes an expired or failed card as dead", () => {
    expect(cardFateOf("expired")).toBe("dead");
    expect(cardFateOf("failed")).toBe("dead");
  });

  it("takes a card a person rejected as rejected", () => {
    expect(cardFateOf("rejected")).toBe("rejected");
  });

  it("keeps an unknown status, or no card, live: unknown is not dead", () => {
    for (const status of ["", "superseded", "EXPIRED", "expired ", " failed", "rejected\n", null]) {
      expect(cardFateOf(status)).toBe("live");
    }
  });
});
