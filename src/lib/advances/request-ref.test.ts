import { describe, expect, it } from "vitest";
import { readableRequestRef } from "./rows";

describe("readableRequestRef", () => {
  it("hides the seed's machine keys", () => {
    expect(readableRequestRef("blue-ridge-adv-load-b")).toBeNull();
    expect(readableRequestRef("blue-ridge-adv-3")).toBeNull();
    expect(readableRequestRef("acme-adv-dup-a")).toBeNull();
    expect(readableRequestRef("  ")).toBeNull();
  });

  it("keeps a reference a person entered", () => {
    expect(readableRequestRef("Text from Marcus, Tuesday")).toBe("Text from Marcus, Tuesday");
    expect(readableRequestRef("ADV-1042")).toBe("ADV-1042");
  });
});
