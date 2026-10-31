import { describe, expect, it } from "vitest";
import { greetingLine, TRUST_LINE } from "./words";

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
});
