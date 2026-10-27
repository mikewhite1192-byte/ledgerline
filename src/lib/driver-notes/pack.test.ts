import { describe, expect, it } from "vitest";
import { buildPack, packText, type PackInput } from "./pack";
import { verifyNote } from "./verify";

const INPUT: PackInput = {
  settlement: {
    id: "00000000-0000-4000-8000-000000000001",
    gross_cents: 125000,
    deductions_cents: 15000,
    net_cents: 110000,
    carry_forward_cents: 0,
  },
  period: { period_start: "2026-10-26", period_end: "2026-11-01" },
  driver: { first_name: "Ana", worker_type: "company", preferred_language: "es" },
  lines: [
    {
      seq: 2,
      kind: "fuel",
      label: "Fuel, Oct 28",
      amount_cents: -15000,
      sources: [{ table: "fuel_purchases", id: "f1" }],
      meta: { gallons: 40, state: "texas" },
    },
    {
      seq: 1,
      kind: "load_pay",
      label: "Load L-1042",
      amount_cents: 125000,
      sources: [
        { table: "loads", id: "l1" },
        { table: "loads", id: "l1" },
      ],
      meta: { loadedMiles: 900, emptyMiles: 100, perMileCents: 62, splitBps: 2550, exception: "late_pod" },
    },
  ],
  previousNetCents: 100000,
};

describe("buildPack", () => {
  it("puts every amount and number the paystub shows on the allowed lists", () => {
    const pack = buildPack(INPUT);
    expect(pack.language).toBe("es");
    expect(pack.seqs).toEqual([1, 2]);
    expect(pack.lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(pack.netChangeCents).toBe(10000);
    expect(pack.loadCount).toBe(1);
    expect(pack.allowedCents).toEqual([0, 62, 10000, 15000, 100000, 110000, 125000]);
    for (const n of ["2026", "10", "26", "11", "1", "2", "28", "1042", "900", "100", "1000", "25.5"]) {
      expect(pack.allowedNumbers, n).toContain(n);
    }
    // A count with no key the pack knows (gallons) is not on the list.
    expect(pack.allowedNumbers).not.toContain("40");
  });

  it("refuses a period date in any other shape", () => {
    expect(() => buildPack({ ...INPUT, period: { period_start: "10/26/2026", period_end: "2026-11-01" } })).toThrow(
      RangeError,
    );
  });

  it("leaves the change out when there is no earlier pay", () => {
    const pack = buildPack({ ...INPUT, previousNetCents: null });
    expect(pack.netChangeCents).toBeNull();
    expect(packText(pack)).not.toContain("Last period");
  });
});

describe("packText", () => {
  it("shows the first name, the lines and the totals, never an id", () => {
    const text = packText(buildPack(INPUT));
    expect(text).toContain("Driver first name: Ana");
    expect(text).toContain("Pay period: Oct 26 to Nov 1, 2026");
    expect(text).toContain("1 | load pay | Load L-1042 | $1,250.00 | loaded miles 900; empty miles 100; per mile $0.62; split 25.5%");
    expect(text).toContain("Net pay: $1,100.00");
    expect(text).toContain("Change from last period: up $100.00");
    expect(text).toContain("Loads this period: 1");
    expect(text).not.toContain(INPUT.settlement.id);
    expect(text).not.toContain("late");
  });

  it("gives a note built from its own numbers a pass", () => {
    const pack = buildPack(INPUT);
    const body =
      "Ana, su pago neto es $1,100.00 [línea 1]. Manejó 1000 millas y el combustible fue $150.00 [línea 2]. Subió $100.00.";
    const result = verifyNote(JSON.stringify({ language: "Spanish", body, cited_seqs: [1, 2] }), pack);
    expect(result).toMatchObject({ ok: true, citedSeqs: [1, 2] });
  });
});
