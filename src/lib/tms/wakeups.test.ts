import { describe, expect, it } from "vitest";
import { readWakeUp } from "./wakeups";

describe("a wake-up payload", () => {
  it("reads only the record type and the id", () => {
    expect(readWakeUp({ recordType: "load", externalId: "syn:x:1001", status: "Delivered", url: "https://x" })).toEqual({
      recordType: "load",
      externalId: "syn:x:1001",
    });
  });

  it("refuses an unknown type, a bad id or a non-object", () => {
    expect(readWakeUp({ recordType: "invoice", externalId: "1" })).toBeNull();
    expect(readWakeUp({ recordType: "load", externalId: "" })).toBeNull();
    expect(readWakeUp({ recordType: "load", externalId: "a".repeat(65) })).toBeNull();
    expect(readWakeUp({ recordType: "load", externalId: "a/b" })).toBeNull();
    expect(readWakeUp({ recordType: "load", externalId: 7 })).toBeNull();
    expect(readWakeUp([])).toBeNull();
    expect(readWakeUp(null)).toBeNull();
  });
});
