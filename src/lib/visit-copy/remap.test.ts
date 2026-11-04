import { describe, expect, it } from "vitest";
import { DEMO_CARRIERS } from "../seed/carriers";
import { isUuid } from "../uuid";
import { templatePlan } from "./build";
import { copyUuid, remapPlanIds } from "./remap";

const A = "0a1b2c3d-0000-4000-8000-000000000001";
const B = "0a1b2c3d-0000-4000-8000-000000000002";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

// Every whole uuid string in a value, keys included.
function uuidsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (isUuid(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) uuidsOf(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      uuidsOf(k, out);
      uuidsOf(v, out);
    }
  }
  return out;
}

describe("copyUuid", () => {
  it("is a version 4 uuid, the same for the same inputs whatever their case, and new for each copy", () => {
    const one = copyUuid(A, ID1);
    expect(isUuid(one)).toBe(true);
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(copyUuid(A.toUpperCase(), ID1.toUpperCase())).toBe(one);
    expect(copyUuid(B, ID1)).not.toBe(one);
    expect(copyUuid(A, ID2)).not.toBe(one);
    expect(one).not.toBe(ID1);
  });
});

describe("remapPlanIds", () => {
  it("swaps every whole uuid in values, nested arrays, jsonb objects and keys, keeping references joined", () => {
    const value = {
      drivers: [{ id: ID1, name: "Pat" }],
      loads: [{ id: ID2, driver_id: ID1, sources: [{ table: "loads", id: ID2 }], flags: { [ID1]: true } }],
      note: `about ${ID1}`,
      amount_cents: 12_345,
      on: false,
      none: null,
    };
    const out = remapPlanIds(value, A);
    const d = copyUuid(A, ID1);
    const l = copyUuid(A, ID2);
    expect(out).toEqual({
      drivers: [{ id: d, name: "Pat" }],
      loads: [{ id: l, driver_id: d, sources: [{ table: "loads", id: l }], flags: { [d]: true } }],
      // A uuid inside a longer string is not an id and is left as it is.
      note: `about ${ID1}`,
      amount_cents: 12_345,
      on: false,
      none: null,
    });
    // A deep copy: the input is untouched.
    expect(value.drivers[0].id).toBe(ID1);
  });

  it("refuses a copy id that is not a uuid and a value it cannot walk", () => {
    expect(() => remapPlanIds({}, "not-a-uuid")).toThrow();
    expect(() => remapPlanIds({ at: new Date(0) }, A)).toThrow();
    expect(() => remapPlanIds({ m: new Map() }, A)).toThrow();
  });

  // It builds every demo carrier's whole plan, which runs past the default 5 seconds on a CI runner.
  it("gives each demo carrier's plan ids that are all new, all its own, and joined the same way", () => {
    for (const carrier of DEMO_CARRIERS) {
      const plan = templatePlan(carrier);
      const before = uuidsOf(plan.rows);
      const one = remapPlanIds(plan.rows, A);
      const two = remapPlanIds(plan.rows, B);
      const afterOne = uuidsOf(one);
      const afterTwo = uuidsOf(two);
      expect(afterOne.size).toBe(before.size);
      expect(afterTwo.size).toBe(before.size);
      for (const id of afterOne) {
        expect(before.has(id)).toBe(false);
        expect(afterTwo.has(id)).toBe(false);
      }
      // The same template id maps to the same copy id everywhere it appears.
      for (const id of before) expect(afterOne.has(copyUuid(A, id))).toBe(true);
      // Row counts are the template's.
      for (const [table, rows] of Object.entries(plan.rows)) {
        expect((one as Record<string, unknown[]>)[table].length, table).toBe((rows as unknown[]).length);
      }
    }
  }, 30_000);
});
