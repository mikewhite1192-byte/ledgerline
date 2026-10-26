import { describe, expect, it } from "vitest";
import { flags } from "./flags";

describe("flags", () => {
  it("ships every outside effect dark", () => {
    expect(flags.aiEnabled).toBe(false);
    expect(flags.accountingEnabled).toBe(false);
    expect(flags.inboundEmailEnabled).toBe(false);
    expect(flags.paymentProvider).toBe("mock");
    expect(flags.triageProvider).toBe("meta");
  });
});
