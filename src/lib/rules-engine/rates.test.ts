import { describe, expect, it } from "vitest";
import { rateOn, type PinnedRate } from "./rates";
import { InputError } from "./types";

function rate(over: Partial<PinnedRate> & { id: string }): PinnedRate {
  return {
    kind: "diesel_index",
    state: null,
    status: "pinned",
    valueMcents: 365_700,
    effectiveFrom: "2026-10-19",
    retiredAt: null,
    ...over,
  };
}

describe("rateOn", () => {
  it("picks the live pin with the latest effective date on or before the day", () => {
    const rates = [
      rate({ id: "a", effectiveFrom: "2026-10-05", valueMcents: 360_000 }),
      rate({ id: "b", effectiveFrom: "2026-10-19", valueMcents: 365_700 }),
      rate({ id: "c", effectiveFrom: "2026-10-28", valueMcents: 371_200 }),
    ];
    expect(rateOn(rates, "diesel_index", null, "2026-10-27")?.id).toBe("b");
    expect(rateOn(rates, "diesel_index", null, "2026-10-19")?.id).toBe("b");
    expect(rateOn(rates, "diesel_index", null, "2026-10-28")?.id).toBe("c");
    expect(rateOn(rates, "diesel_index", null, "2026-10-04")).toBeNull();
  });

  it("never returns a suggestion or a retired pin, whatever their dates", () => {
    const rates = [
      rate({ id: "s", status: "suggested", effectiveFrom: null, valueMcents: 999_000 }),
      rate({ id: "u", status: "unconfirmed", effectiveFrom: null, valueMcents: null }),
      rate({ id: "r", effectiveFrom: "2026-10-26", retiredAt: "2026-10-27T12:00:00Z", valueMcents: 371_200 }),
      rate({ id: "p", effectiveFrom: "2026-10-12" }),
    ];
    expect(rateOn(rates, "diesel_index", null, "2026-10-27")?.id).toBe("p");
    expect(rateOn(rates.slice(0, 3), "diesel_index", null, "2026-10-27")).toBeNull();
  });

  it("keeps kinds and states apart", () => {
    const rates = [
      rate({ id: "d" }),
      rate({ id: "il", kind: "ifta_rate", state: "IL", valueMcents: 45_400 }),
      rate({ id: "in", kind: "ifta_rate", state: "IN", valueMcents: 61_000 }),
    ];
    expect(rateOn(rates, "ifta_rate", "IN", "2026-10-27")?.id).toBe("in");
    expect(rateOn(rates, "ifta_rate", "OH", "2026-10-27")).toBeNull();
    expect(rateOn(rates, "diesel_index", null, "2026-10-27")?.id).toBe("d");
  });

  it("breaks a tie on the same day by the larger id, whatever the order read", () => {
    const one = rate({ id: "0001" });
    const two = rate({ id: "0002" });
    expect(rateOn([one, two], "diesel_index", null, "2026-10-27")?.id).toBe("0002");
    expect(rateOn([two, one], "diesel_index", null, "2026-10-27")?.id).toBe("0002");
  });

  it("refuses a bad kind, day or state, and a live pin with no date or value", () => {
    expect(() => rateOn([], "gas" as never, null, "2026-10-27")).toThrow(InputError);
    expect(() => rateOn([], "diesel_index", null, "10/27/2026")).toThrow(InputError);
    expect(() => rateOn([], "diesel_index", "IL", "2026-10-27")).toThrow(InputError);
    expect(() => rateOn([], "ifta_rate", null, "2026-10-27")).toThrow(InputError);
    expect(() => rateOn([rate({ id: "x", effectiveFrom: null })], "diesel_index", null, "2026-10-27")).toThrow(InputError);
    expect(() => rateOn([rate({ id: "x", valueMcents: 0 })], "diesel_index", null, "2026-10-27")).toThrow(InputError);
    expect(() => rateOn([rate({ id: "x", valueMcents: 1.5 })], "diesel_index", null, "2026-10-27")).toThrow(InputError);
  });
});
