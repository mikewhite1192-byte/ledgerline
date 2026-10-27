import { describe, expect, it } from "vitest";
import { enumValuesOf, redactArgs, redactValue } from "../redact";
import { REDACT_ENUMS } from "../registry";

const ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

// Every string leaf in a redacted value: what could carry free text into the log.
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe("redactArgs", () => {
  it("keeps ids, dates, numbers, booleans and declared enum values", () => {
    expect(
      redactArgs(
        {
          driverId: ID,
          requestedOn: "2026-10-24",
          amountCents: 30_000,
          flag: true,
          none: null,
          operatorVerdict: "eligible",
          reasonCategories: ["driver_asked", "fee_applies"],
        },
        REDACT_ENUMS,
      ),
    ).toEqual({
      driverId: ID,
      requestedOn: "2026-10-24",
      amountCents: 30_000,
      flag: true,
      none: null,
      operatorVerdict: "eligible",
      reasonCategories: ["driver_asked", "fee_applies"],
    });
  });

  it("lets no other string through, at any depth", () => {
    const out = redactArgs(
      {
        note: "Please wire it to account 12345",
        nested: { email: "driver@example.test", list: ["a", ID, { deep: "Jane Doe" }] },
        notQuiteDate: "2026-02-30",
        upperId: "not-a-uuid",
      },
      REDACT_ENUMS,
    );
    expect(out).toEqual({
      note: { len: 31 },
      nested: { email: { len: 19 }, list: [{ len: 1 }, ID, { deep: { len: 8 } }] },
      notQuiteDate: { len: 10 },
      upperId: { len: 10 },
    });
    expect(strings(out)).toEqual([ID]);
  });

  it("bounds depth and array length, and drops values with no JSON meaning", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redactValue(deep, REDACT_ENUMS))).not.toContain("leaf");
    expect((redactValue(Array.from({ length: 80 }, () => 1), REDACT_ENUMS) as unknown[]).length).toBe(50);
    expect(redactValue(Number.NaN, REDACT_ENUMS)).toBeNull();
    expect(redactArgs("text", REDACT_ENUMS)).toEqual({});
    expect(redactArgs([1, 2], REDACT_ENUMS)).toEqual({});
  });
});

describe("enumValuesOf", () => {
  it("collects enum and const strings at any depth", () => {
    const schema = {
      type: "object",
      properties: {
        a: { enum: ["x", "y", 3] },
        b: { anyOf: [{ const: "z" }, { type: "array", items: { enum: ["w"] } }] },
      },
    };
    expect([...enumValuesOf(schema)].sort()).toEqual(["w", "x", "y", "z"]);
  });
});
