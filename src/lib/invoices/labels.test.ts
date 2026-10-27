import { describe, expect, it } from "vitest";
import { quickBooksStanding } from "./labels";

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
