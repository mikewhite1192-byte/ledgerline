import { describe, expect, it } from "vitest";
import { STAFF_ONLY_NOTE } from "../../components/app/staff-only";
import { OUTCOME_FALLBACK, outcomeLabel, quickBooksStanding, reviewWriteLabel } from "./labels";

describe("quickBooksStanding", () => {
  it("names the QuickBooks record when one is stored, whatever the attempts say", () => {
    expect(quickBooksStanding("0412", [])).toBe("In QuickBooks, record ending 0412");
    expect(quickBooksStanding("0412", ["unknown", "failed"])).toBe("In QuickBooks, record ending 0412");
  });

  it("says a confirmed send is confirmed even when an earlier attempt was not", () => {
    expect(quickBooksStanding(null, ["unknown", "confirmed"])).toBe("Confirmed by QuickBooks");
  });

  it("never reads a send nobody confirmed as sent or as not sent", () => {
    const words = quickBooksStanding(null, ["unknown"]);
    expect(words).toBe("Not confirmed yet");
    expect(words).not.toMatch(/\bsent\b/i);
    expect(quickBooksStanding(null, ["failed", "unknown"])).toBe("Not confirmed yet");
  });

  it("says a sent record is waiting on QuickBooks and a reserved one has not gone out", () => {
    expect(quickBooksStanding(null, ["sent"])).toBe("Sent, waiting for QuickBooks to confirm it");
    expect(quickBooksStanding(null, ["reserved"])).toBe("Waiting to send");
  });

  it("does not say whether QuickBooks holds a record whose last attempt failed", () => {
    const words = quickBooksStanding(null, ["failed"]);
    expect(words).toBe("Not confirmed. The last attempt failed");
    expect(words).not.toMatch(/not sent|not in QuickBooks/i);
  });

  it("says not sent yet only when nothing was ever tried", () => {
    expect(quickBooksStanding(null, [])).toBe("Not sent yet");
  });
});

// A demo visitor's press on a staff-only invoice or payment button: the staff check answers 403
// "judge", and every invoice screen says the button is for the carrier's staff, never the fallback.
describe("the judge refusal on invoice buttons", () => {
  it("reads as the staff-only line on the outcome and review buttons alike", () => {
    expect(outcomeLabel("judge")).toBe(STAFF_ONLY_NOTE);
    expect(reviewWriteLabel("judge")).toBe(STAFF_ONLY_NOTE);
    expect(outcomeLabel("judge")).not.toBe(OUTCOME_FALLBACK);
  });
});
