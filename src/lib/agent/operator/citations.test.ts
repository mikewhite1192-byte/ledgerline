import { describe, expect, it } from "vitest";
import { idsIn, validateRefs } from "./citations";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("citations", () => {
  it("collects every id-shaped string in a tool result, lower-cased", () => {
    const ids = idsIn({ driver: { id: A.toUpperCase() }, rows: [{ loadId: B }, "not an id"], n: 5 });
    expect([...ids].sort()).toEqual([A, B]);
  });

  it("keeps a ref only when its table is known and a tool returned its id", () => {
    const trusted = new Set([A]);
    expect(validateRefs([{ table: "drivers", id: A }], trusted)).toEqual([{ table: "drivers", id: A }]);
    // An id no tool returned
    expect(validateRefs([{ table: "drivers", id: B }], trusted)).toEqual([]);
    // A table the records do not know
    expect(validateRefs([{ table: "memberships", id: A }], trusted)).toEqual([]);
    // Not an id at all
    expect(validateRefs([{ table: "drivers", id: "BR-D07" }], trusted)).toEqual([]);
  });

  it("drops duplicates and malformed refs without throwing", () => {
    const trusted = new Set([A]);
    const refs = [
      { table: "drivers", id: A },
      { table: "drivers", id: A.toUpperCase() },
      null,
      { table: 5, id: A },
    ] as unknown as { table: string; id: string }[];
    expect(validateRefs(refs, trusted)).toEqual([{ table: "drivers", id: A }]);
  });
});
