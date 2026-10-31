import { describe, expect, it } from "vitest";
import { badgeCount, greetingLine, moreWaiting, TRUST_LINE, YES_FAILED, yesConfirmation, yesRefused } from "./words";

describe("the agent card's words", () => {
  it("greets the carrier by name, and anyone else plainly", () => {
    expect(greetingLine("Blue Ridge")).toBe("Hey, Blue Ridge. How can I be helpful?");
    expect(greetingLine("  Blue Ridge  ")).toBe("Hey, Blue Ridge. How can I be helpful?");
    expect(greetingLine("")).toBe("Hey there. How can I be helpful?");
    expect(greetingLine("   ")).toBe("Hey there. How can I be helpful?");
    expect(greetingLine(null)).toBe("Hey there. How can I be helpful?");
    expect(greetingLine(undefined)).toBe("Hey there. How can I be helpful?");
  });

  it("says where the numbers come from and that nothing moves without an approval", () => {
    expect(TRUST_LINE).toBe("Every number comes from your records, and nothing is paid or sent until you approve it.");
  });

  it("counts the questions waiting on the launcher and under the bubble", () => {
    expect([0, -1, 1.5].map(badgeCount)).toEqual([null, null, null]);
    expect([1, 9, 10].map(badgeCount)).toEqual(["1", "9", "9+"]);
    expect([0, 1, 2].map(moreWaiting)).toEqual([null, "1 more waiting", "2 more waiting"]);
  });

  it("says no more than happened after Yes, and only fixed words when it did not go through", () => {
    expect(yesConfirmation("advance_payout", "done")).toBe("Sent. The advance is on its way.");
    expect(yesConfirmation("invoice_post", "done")).toBe("Posted to QuickBooks sandbox.");
    expect(yesConfirmation("load_move", "done")).toBe("Done. It went through the usual checks.");
    expect(yesConfirmation("advance_payout", "executing")).toBe("Approved. It is finishing now.");
    expect(yesConfirmation("advance_payout", undefined)).toBe("Approved. It is finishing now.");
    expect(yesRefused("needs_confirm", "staff")).toBe("This one needs a closer look first. Open it from Needs you on Home.");
    expect(yesRefused("judge", "staff only")).toBe("staff only");
    expect(yesRefused("connection to db-host refused", "staff")).toBe(YES_FAILED);
    expect(yesRefused("toString", "staff")).toBe(YES_FAILED);
    expect(yesRefused(undefined, "staff")).toBe(YES_FAILED);
  });
});
