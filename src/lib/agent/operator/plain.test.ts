import { describe, expect, it } from "vitest";
import { plainAnswer } from "./plain";

// The dashes are written as escapes so this file holds none itself.
const EM = "—";
const EN = "–";

describe("plainAnswer", () => {
  it("writes a pause dash as a comma and a leading one as a bullet", () => {
    expect(plainAnswer(`Today ${EM} reads only.`)).toBe("Today, reads only.");
    expect(plainAnswer(`- BR-INV-10012 ${EM} $1,041.60 balance`)).toBe("- BR-INV-10012, $1,041.60 balance");
    expect(plainAnswer(`${EM} first\n${EN} second`)).toBe("- first\n- second");
    expect(plainAnswer(`Nothing yet ${EM}.`)).toBe("Nothing yet.");
  });

  it("writes a tight dash between figures as a range", () => {
    expect(plainAnswer(`10${EN}20 days late`)).toBe("10 to 20 days late");
  });

  it("writes whole ISO dates as a month and day, and leaves ids alone", () => {
    expect(plainAnswer("as of 2026-11-03, week 2026-10-19 to 2026-10-25")).toBe(
      "as of Nov 3, 2026, week Oct 19, 2026 to Oct 25, 2026",
    );
    expect(plainAnswer("load LD-2026-11-03 and 12026-11-03x")).toBe("load LD-2026-11-03 and 12026-11-03x");
    expect(plainAnswer("2026-13-40")).toBe("2026-13-40");
  });

  it("leaves text with neither unchanged", () => {
    expect(plainAnswer("Pay is $2,225.00 this week.")).toBe("Pay is $2,225.00 this week.");
  });
});
