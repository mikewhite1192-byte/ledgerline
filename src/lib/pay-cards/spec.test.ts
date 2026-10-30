import { describe, expect, it } from "vitest";
import { PAY_CARD_ART } from "./art";
import { cardSpec, sameSpec, topChange, type CardSourceInput } from "./spec";

// A pay card's figures and words, worked out in code from the settlement's stored rows: the
// engine's own integer cents, picked up and worded, never recomputed.

const SETTLEMENT = "5b2c8f0e-1d1a-4c55-9a51-7f3e5d6a0b11";
const DRIVER = "c1f0a9d2-3b4e-4f60-8a71-92b3c4d5e6f7";

function input(over: Partial<CardSourceInput> = {}): CardSourceInput {
  return {
    carrierName: "  Blue   Ridge Freight ",
    settlement: {
      id: SETTLEMENT,
      status: "approved",
      gross_cents: 141_200,
      deductions_cents: 23_450,
      net_cents: 117_750,
      carry_forward_cents: 0,
    },
    period: { period_start: "2026-10-19", period_end: "2026-10-25" },
    driver: { id: DRIVER, first_name: " Ana  María ", preferred_language: "en" },
    lines: [
      {
        kind: "load_pay",
        amount_cents: 80_000,
        sources: [{ table: "loads", id: "L-1" }],
        meta: { loadedMiles: 1_000, emptyMiles: 100 },
      },
      {
        kind: "load_pay",
        amount_cents: 61_200,
        sources: [{ table: "loads", id: "L-2" }],
        meta: { loadedMiles: 800, emptyMiles: 50 },
      },
      { kind: "fuel", amount_cents: -23_450, sources: [], meta: null },
    ],
    previousNetCents: 110_000,
    previousLines: [
      { kind: "load_pay", amount_cents: 130_000 },
      { kind: "fuel", amount_cents: -20_000 },
    ],
    ...over,
  };
}

describe("cardSpec", () => {
  it("prints a per-mile driver's figures, loads and miles exactly as the settlement holds them", () => {
    const spec = cardSpec(input());
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec).toMatchObject({
      version: 1,
      settlementId: SETTLEMENT,
      language: "en",
      firstName: "Ana María",
      weekText: "Week of Oct 19 to Oct 25, 2026",
      netCents: 117_750,
      grossCents: 141_200,
      deductionsCents: 23_450,
      loads: 2,
      miles: 1_950,
      changeCents: 7_750,
      // Load pay grew 11,200 and fuel grew 3,450: load pay is the bigger change.
      topChange: { kind: "load_pay", deltaCents: 11_200 },
      carriedCents: 0,
      status: "approved",
      amountsCents: [7_750, 11_200, 23_450, 117_750, 141_200],
    });
    expect(PAY_CARD_ART).toContain(spec.art);
    expect(spec.text).toEqual({
      carrier: "Blue Ridge Freight",
      title: "Pay card",
      name: "Ana María",
      week: "Week of Oct 19 to Oct 25, 2026",
      netLabel: "Take-home pay",
      net: "$1,177.50",
      earned: "Earned $1,412.00",
      takenOut: "Taken out $234.50",
      work: "2 loads · 1,950 miles",
      change: "Up $77.50 from last week",
      topChange: "Biggest change: Load pay, up $112.00",
      carried: null,
      status: "Approved",
      testMode: "Test mode",
    });
  });

  it("leaves miles off a percent-of-linehaul driver's card when the load lines carry none", () => {
    const spec = cardSpec(
      input({
        lines: [
          { kind: "load_pay", amount_cents: 141_200, sources: [{ table: "loads", id: "L-9" }], meta: { percentBps: 7_000 } },
          { kind: "lease", amount_cents: -23_450, sources: [], meta: null },
        ],
      }),
    );
    expect(spec?.loads).toBe(1);
    expect(spec?.miles).toBeNull();
    expect(spec?.text.work).toBe("1 load");
  });

  it("counts a load once however many lines it pays, and drops miles when any load line lacks them", () => {
    const spec = cardSpec(
      input({
        lines: [
          { kind: "load_pay", amount_cents: 100_000, sources: [{ table: "loads", id: "L-1" }], meta: { loadedMiles: 900, emptyMiles: 0 } },
          { kind: "load_pay", amount_cents: 41_200, sources: [{ table: "loads", id: "L-1" }], meta: { loadedMiles: 300 } },
        ],
      }),
    );
    expect(spec?.loads).toBe(1);
    expect(spec?.miles).toBeNull();
  });

  it("says first week, with no change and no biggest change, when there is no earlier settled week", () => {
    const spec = cardSpec(input({ previousNetCents: null, previousLines: null }));
    expect(spec?.changeCents).toBeNull();
    expect(spec?.topChange).toBeNull();
    expect(spec?.text.change).toBe("First week on record");
    expect(spec?.text.topChange).toBeNull();
    expect(spec?.amountsCents).toEqual([23_450, 117_750, 141_200]);
  });

  it("says down, or the same, against last week", () => {
    expect(cardSpec(input({ previousNetCents: 120_000 }))?.text.change).toBe("Down $22.50 from last week");
    const same = cardSpec(input({ previousNetCents: 117_750 }));
    expect(same?.changeCents).toBe(0);
    expect(same?.text.change).toBe("Same as last week");
    // A zero change prints no amount, so it is not one of the card's amounts.
    expect(same?.amountsCents).not.toContain(0);
  });

  it("prints the carried shortfall, without its sign", () => {
    const spec = cardSpec(
      input({
        settlement: { ...input().settlement, net_cents: 0, deductions_cents: 141_200, carry_forward_cents: -5_000 },
      }),
    );
    expect(spec?.carriedCents).toBe(-5_000);
    expect(spec?.text.carried).toBe("Carried shortfall $50.00");
    expect(spec?.amountsCents).toContain(5_000);
  });

  it("words a Spanish driver's card in Spanish, with the same figures", () => {
    const spec = cardSpec(input({ driver: { id: DRIVER, first_name: "José", preferred_language: "es" } }));
    expect(spec?.language).toBe("es");
    expect(spec?.netCents).toBe(117_750);
    expect(spec?.text).toMatchObject({
      title: "Tarjeta de pago",
      week: "Semana del 19 de octubre al 25 de octubre de 2026",
      netLabel: "Pago neto",
      net: "$1,177.50",
      earned: "Ganado $1,412.00",
      takenOut: "Descontado $234.50",
      work: "2 cargas · 1,950 millas",
      change: "$77.50 más que la semana pasada",
      topChange: "Mayor cambio: Pago por cargas, sube $112.00",
      status: "Aprobado",
      testMode: "Modo de prueba",
    });
  });

  it("says paid on a paid settlement, and gives no card before approval", () => {
    expect(cardSpec(input({ settlement: { ...input().settlement, status: "paid" } }))?.text.status).toBe("Paid");
    expect(cardSpec(input({ settlement: { ...input().settlement, status: "draft" } }))).toBeNull();
  });

  it("refuses a figure that is not whole cents", () => {
    expect(() => cardSpec(input({ settlement: { ...input().settlement, net_cents: 1.5 } }))).toThrow();
  });

  it("gives the same driver the same picture every time", () => {
    expect(cardSpec(input())?.art).toBe(cardSpec(input())?.art);
  });
});

describe("topChange", () => {
  it("breaks a tie by the paystub's own kind order", () => {
    const lines = [
      { kind: "fuel", amount_cents: -15_000 },
      { kind: "load_pay", amount_cents: 105_000 },
    ];
    const previous = [
      { kind: "fuel", amount_cents: -10_000 },
      { kind: "load_pay", amount_cents: 100_000 },
    ];
    // Both grew by 5,000; load pay is listed before fuel.
    expect(topChange(lines, previous)).toEqual({ kind: "load_pay", deltaCents: 5_000 });
  });

  it("orders a kind it does not know after the known ones, by name", () => {
    const lines = [
      { kind: "zz_bonus", amount_cents: 1_000 },
      { kind: "aa_bonus", amount_cents: 1_000 },
    ];
    expect(topChange(lines, [])).toEqual({ kind: "aa_bonus", deltaCents: 1_000 });
    expect(topChange([{ kind: "zz_bonus", amount_cents: 1_000 }, { kind: "escrow", amount_cents: -1_000 }], [])).toEqual({
      kind: "escrow",
      deltaCents: 1_000,
    });
  });

  it("reads a kind that shrank as down, and no change at all as none", () => {
    expect(topChange([{ kind: "load_pay", amount_cents: 90_000 }], [{ kind: "load_pay", amount_cents: 100_000 }])).toEqual({
      kind: "load_pay",
      deltaCents: -10_000,
    });
    expect(topChange([{ kind: "load_pay", amount_cents: 1 }], [{ kind: "load_pay", amount_cents: 1 }])).toBeNull();
    expect(topChange([{ kind: "load_pay", amount_cents: 1 }], null)).toBeNull();
  });
});

describe("sameSpec", () => {
  // Every object's keys in reverse order, the way jsonb may hand them back.
  function reversed(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(reversed);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).reverse().map((k) => [k, reversed(o[k])]));
    }
    return v;
  }

  it("matches a spec read back from storage with its keys in another order, and nothing else", () => {
    const spec = cardSpec(input());
    const stored = reversed(JSON.parse(JSON.stringify(spec))) as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(spec));
    expect(sameSpec(stored, spec)).toBe(true);
    expect(sameSpec({ ...stored, netCents: 117_751 }, spec)).toBe(false);
    expect(sameSpec({ ...stored, text: { ...(stored.text as object), net: "$1,177.51" } }, spec)).toBe(false);
    expect(sameSpec({ ...stored, amountsCents: [...(stored.amountsCents as number[])].reverse() }, spec)).toBe(false);
    expect(sameSpec(null, spec)).toBe(false);
  });
});
