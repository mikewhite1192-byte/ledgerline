import { describe, expect, it } from "vitest";
import { dismissKey } from "./dismiss-key";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const SUB = "d3b07384-d9a0-4c9b-8a5e-0a1b2c3d4e5f";

describe("the closed set's key", () => {
  it("is stable, and differs per tenant and per sign-in", () => {
    const key = dismissKey(TENANT, SUB);
    expect(dismissKey(TENANT, SUB)).toBe(key);
    expect(dismissKey(OTHER_TENANT, SUB)).not.toBe(key);
    expect(dismissKey(TENANT, "another-sub")).not.toBe(key);
  });

  it("is asks: and 32 hex characters, with neither input in it", () => {
    const key = dismissKey(TENANT, SUB);
    expect(key).toMatch(/^asks:[0-9a-f]{32}$/);
    expect(key).not.toContain(TENANT);
    expect(key).not.toContain(SUB);
  });
});
