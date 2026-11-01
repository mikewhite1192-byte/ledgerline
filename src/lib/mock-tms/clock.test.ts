import { describe, expect, it } from "vitest";
import { changeAt } from "./clock";

describe("the sample dispatch system's change time", () => {
  const now = Date.parse("2026-11-03T15:00:00.000Z");

  it("is now when nothing is later", () => {
    expect(changeAt(now, "2026-11-02T05:00:00.000Z", ["2026-11-03T14:00:00.000Z", null])).toBe("2026-11-03T15:00:00.000Z");
  });

  it("never reads before the feed's floor", () => {
    expect(changeAt(now, "2026-11-04T05:00:00.000Z", [])).toBe("2026-11-04T05:00:00.000Z");
  });

  it("is a second after the latest row or update when those are later", () => {
    expect(changeAt(now, null, ["2026-11-03T15:00:00.000Z", "2026-11-03T15:00:30.000Z"])).toBe("2026-11-03T15:00:31.000Z");
  });
});
