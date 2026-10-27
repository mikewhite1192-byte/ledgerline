import { describe, expect, it } from "vitest";
import { isAllowlisted } from "./deliver";

describe("isAllowlisted", () => {
  it("matches whole addresses only, ignoring case and spaces", () => {
    expect(isAllowlisted("Drv-1@Carrier.example", [" drv-1@carrier.example "])).toBe(true);
    expect(isAllowlisted("drv-1@carrier.example", [])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["carrier.example"])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["drv-1@carrier.example.evil"])).toBe(false);
    expect(isAllowlisted("  ", [""])).toBe(false);
  });
});
