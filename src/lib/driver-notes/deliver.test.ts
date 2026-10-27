import { describe, expect, it } from "vitest";
import { isAllowlisted, maskEmail } from "./deliver";

describe("maskEmail", () => {
  it("keeps two characters of the name and the domain", () => {
    expect(maskEmail("driver.one@blueridge.example")).toBe("dr***@blueridge.example");
    expect(maskEmail("ab@x.example")).toBe("a***@x.example");
    expect(maskEmail("a@x.example")).toBe("***@x.example");
    expect(maskEmail("no-at-sign")).toBe("***");
  });
});

describe("isAllowlisted", () => {
  it("matches whole addresses only, ignoring case and spaces", () => {
    expect(isAllowlisted("Drv-1@Carrier.example", [" drv-1@carrier.example "])).toBe(true);
    expect(isAllowlisted("drv-1@carrier.example", [])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["carrier.example"])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["drv-1@carrier.example.evil"])).toBe(false);
    expect(isAllowlisted("  ", [""])).toBe(false);
  });
});
