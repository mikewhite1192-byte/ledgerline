import { describe, expect, it } from "vitest";
import { generatePassword } from "./password";

describe("generatePassword", () => {
  it("meets the pool policy every time", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(24);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!#%+\-=?@^_]/);
      expect(pw).not.toMatch(/[IOl01\s'"\\]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(seen.size).toBe(50);
  });

  it("refuses a length under 12", () => {
    expect(() => generatePassword(11)).toThrow(/12/);
  });
});
