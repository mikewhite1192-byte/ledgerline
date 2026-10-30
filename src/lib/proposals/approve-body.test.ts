import { describe, expect, it } from "vitest";
import { parseApproveBody } from "./approve-body";

// The approve request's body (design 4.2 step 5): strict, the reason trimmed and 10 to 240
// characters, auditedAt an ISO instant, anything else a bad request.

const AT = "2026-10-28T15:00:00.123Z";

describe("parseApproveBody", () => {
  it("reads an empty body as no confirm and no override", () => {
    expect(parseApproveBody("")).toEqual({ confirmed: false, overrideReason: null, auditedAt: null });
    expect(parseApproveBody("{}")).toEqual({ confirmed: false, overrideReason: null, auditedAt: null });
  });

  it("reads a full override body, trimming the reason", () => {
    const body = JSON.stringify({ confirmed: true, overrideReason: "  Driver showed the receipt in person  ", auditedAt: AT });
    expect(parseApproveBody(body)).toEqual({
      confirmed: true,
      overrideReason: "Driver showed the receipt in person",
      auditedAt: AT,
    });
  });

  it("keeps a reason of exactly 10 and exactly 240 characters", () => {
    expect(parseApproveBody(JSON.stringify({ overrideReason: "a".repeat(10) }))?.overrideReason).toBe("a".repeat(10));
    expect(parseApproveBody(JSON.stringify({ overrideReason: "a".repeat(240) }))?.overrideReason).toBe("a".repeat(240));
  });

  it.each([
    ["empty", ""],
    ["nine characters", "a".repeat(9)],
    ["blank once trimmed", "            "],
    ["nine once trimmed", `   ${"a".repeat(9)}   `],
    ["241 characters", "a".repeat(241)],
  ])("refuses a reason that is %s", (_name, overrideReason) => {
    expect(parseApproveBody(JSON.stringify({ overrideReason }))).toBeNull();
  });

  it.each(["yesterday", "2026-10-28", "2026-10-28T15:00:00Z", "2026-10-28T15:00:00.123"])(
    "refuses auditedAt %s",
    (auditedAt) => {
      expect(parseApproveBody(JSON.stringify({ auditedAt }))).toBeNull();
    },
  );

  it("refuses an extra key, a wrong type, bad JSON and a non-object", () => {
    expect(parseApproveBody(JSON.stringify({ confirmed: true, approvedBy: "someone" }))).toBeNull();
    expect(parseApproveBody(JSON.stringify({ confirmed: "yes" }))).toBeNull();
    expect(parseApproveBody(JSON.stringify({ overrideReason: 12345678901 }))).toBeNull();
    expect(parseApproveBody("{not json")).toBeNull();
    expect(parseApproveBody("[]")).toBeNull();
    expect(parseApproveBody("null")).toBeNull();
  });

  it("reads a policy card's edits as given, and leaves them out when none are sent", () => {
    const edits = { net_pay_floor_cents: "30000", advance_recovery_cap_cents: "null", percent_base: "linehaul" };
    expect(parseApproveBody(JSON.stringify({ confirmed: true, edits }))).toEqual({
      confirmed: true,
      overrideReason: null,
      auditedAt: null,
      edits,
    });
    expect(parseApproveBody(JSON.stringify({ edits: {} }))?.edits).toEqual({});
    expect(parseApproveBody("{}")).not.toHaveProperty("edits");
  });

  it("refuses edits with a bad key, a bad value or more than one per rule", () => {
    const bad = (edits: unknown) => parseApproveBody(JSON.stringify({ edits }));
    expect(bad({ __proto__x: "1" })).toBeNull();
    expect(bad({ Net_pay: "1" })).toBeNull();
    expect(bad({ net_pay_floor_cents: "$300" })).toBeNull();
    expect(bad({ net_pay_floor_cents: "-1" })).toBeNull();
    expect(bad({ net_pay_floor_cents: 30000 })).toBeNull();
    expect(bad({ net_pay_floor_cents: "1".repeat(10) })).toBeNull();
    expect(bad(["net_pay_floor_cents"])).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`rule_${"k".repeat(i + 1)}`, "1"]));
    expect(bad(many)).toBeNull();
  });
});
