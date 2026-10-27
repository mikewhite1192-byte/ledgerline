import { describe, expect, it } from "vitest";
import { idempotencyKey, isAttempt, isCanonicalUuid, memoCodeOf, requestIdOf } from "./keys";

const SUBJECT = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("idempotencyKey", () => {
  it("is kind:subject:attempt, the same every time", () => {
    expect(idempotencyKey("advance_payout", SUBJECT, 1)).toBe(`advance_payout:${SUBJECT}:1`);
    expect(idempotencyKey("invoice", SUBJECT, 20)).toBe(`invoice:${SUBJECT}:20`);
    expect(idempotencyKey("advance_payout", SUBJECT, 1)).toBe(
      idempotencyKey("advance_payout", SUBJECT, 1),
    );
  });

  it("refuses an unknown kind, a non-canonical subject and an attempt out of range", () => {
    expect(() => idempotencyKey("refund" as never, SUBJECT, 1)).toThrow(RangeError);
    expect(() => idempotencyKey("invoice", SUBJECT.toUpperCase(), 1)).toThrow(RangeError);
    expect(() => idempotencyKey("invoice", `${SUBJECT} `, 1)).toThrow(RangeError);
    for (const a of [0, 21, 1.5, -1, Number.NaN]) {
      expect(() => idempotencyKey("invoice", SUBJECT, a)).toThrow(RangeError);
    }
  });
});

describe("requestIdOf", () => {
  it("is the action id without dashes: 32 lowercase hex", () => {
    expect(requestIdOf(ACTION)).toBe("f47ac10b58cc4372a5670e02b2c3d479");
    expect(requestIdOf(ACTION)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses anything but a lowercase UUID", () => {
    expect(() => requestIdOf(ACTION.toUpperCase())).toThrow(RangeError);
    expect(() => requestIdOf("not-a-uuid")).toThrow(RangeError);
  });
});

describe("helpers", () => {
  it("checks UUIDs and attempts whole", () => {
    expect(isCanonicalUuid(ACTION)).toBe(true);
    expect(isCanonicalUuid(`x${ACTION}`)).toBe(false);
    expect(isCanonicalUuid(42)).toBe(false);
    expect(isAttempt(1)).toBe(true);
    expect(isAttempt(20)).toBe(true);
    expect(isAttempt("1")).toBe(false);
  });

  it("names the record a payout pays, never a person", () => {
    expect(memoCodeOf({ subjectTable: "advances", subjectId: SUBJECT })).toBe(
      `advances:${SUBJECT}`,
    );
  });
});
