import { describe, expect, it } from "vitest";
import { cents } from "../rules-engine";
import { buildCarrierPlan } from "../seed/plan";
import { DEMO_CARRIERS } from "../seed/carriers";
import {
  chargeArgsOf,
  chargeArgsSchema,
  chargeMatches,
  detentionChargeOf,
  detentionDescription,
  type DetentionChargeRows,
} from "./detention-charge";

// The one check the limit, both tools and the executor share, on the synthetic seed plan.

const plan = buildCarrierPlan(DEMO_CARRIERS[0], "2026-11-02");
const rowsFor = (loadId: string): DetentionChargeRows => {
  const load = plan.rows.loads.find((l) => l.id === loadId)!;
  return {
    load,
    customer: plan.rows.customers.find((c) => c.id === load.customer_id)!,
    miles: plan.rows.load_state_miles.filter((m) => m.load_id === loadId),
    accessorials: plan.rows.load_accessorials.filter((a) => a.load_id === loadId),
    invoices: plan.rows.invoices.filter((i) => i.load_id === loadId),
  };
};

describe("detentionChargeOf", () => {
  it("gives the seed's three planted charges, 237,500 cents in all, onto each load's open invoice", () => {
    const charges = plan.planted.detentionLoadIds.map((id) => {
      const check = detentionChargeOf(rowsFor(id));
      if (!check.ok) throw new Error(check.reason);
      return check.charge;
    });
    expect(charges.map((c) => c.amountCents)).toEqual([73_750, 90_000, 73_750]);
    expect(charges.reduce((n, c) => n + c.amountCents, 0)).toBe(237_500);
    for (const c of charges) {
      expect(c.invoiceAmountAfterCents).toBe(c.invoiceAmountBeforeCents + c.amountCents);
      expect(c.stops.every((s) => s.cents > 0)).toBe(true);
    }
  });

  it("says why a load has no charge to add", () => {
    const rows = rowsFor(plan.planted.detentionLoadIds[0]);
    const unknown = {
      ...rows,
      load: { ...rows.load, pickup_arrived_at: null, pickup_departed_at: null },
    };
    const billed = {
      ...rows,
      accessorials: [
        ...rows.accessorials,
        {
          id: "5b0e7a3c-1d2f-4e6a-9b8c-7d6e5f4a3b2c",
          load_id: rows.load.id,
          kind: "detention" as const,
          seq: 1,
          amount_cents: 100,
          paid_by_driver: false,
          description: "Detention",
        },
      ],
    };
    const differs = { ...rows, invoices: rows.invoices.map((i) => ({ ...i, amount_cents: i.amount_cents + 1 })) };
    expect(detentionChargeOf(unknown)).toEqual({ ok: false, reason: "no_detention" });
    expect(detentionChargeOf(billed)).toEqual({ ok: false, reason: "already_billed" });
    expect(detentionChargeOf({ ...rows, invoices: [] })).toEqual({ ok: false, reason: "no_invoice" });
    expect(detentionChargeOf(differs)).toEqual({ ok: false, reason: "invoice_mismatch" });
  });

  it("refuses an invoice that is not open, or open but posted to accounting", () => {
    const rows = rowsFor(plan.planted.detentionLoadIds[0]);
    const posted = { ...rows, invoices: rows.invoices.map((i) => ({ ...i, qbo_id: "77" })) };
    const sent = { ...rows, invoices: rows.invoices.map((i) => ({ ...i, status: "paid" as const })) };
    expect(detentionChargeOf(posted)).toEqual({ ok: false, reason: "invoice_posted" });
    expect(detentionChargeOf(sent)).toEqual({ ok: false, reason: "invoice_posted" });
  });
});

describe("the stored args", () => {
  const check = detentionChargeOf(rowsFor(plan.planted.detentionLoadIds[0]));
  if (!check.ok) throw new Error("no charge");
  const charge = check.charge;
  const args = chargeArgsOf(charge);

  it("parse with their own schema and match the charge they came from", () => {
    expect(chargeArgsSchema.parse(args)).toEqual(args);
    expect(chargeMatches(args, charge)).toBe(true);
  });

  it("stop matching when any one figure or instant moves", () => {
    const moved = [
      { ...args, amountCents: args.amountCents + 1 },
      { ...args, invoiceAmountBeforeCents: args.invoiceAmountBeforeCents - 1 },
      { ...args, hourlyCents: args.hourlyCents + 1 },
      { ...args, freeMinutes: args.freeMinutes + 1 },
      { ...args, stops: args.stops.map((s, i) => (i === 0 ? { ...s, departedAt: "2026-10-01T00:00:00.000Z" } : s)) },
      { ...args, stops: args.stops.map((s, i) => (i === 0 ? { ...s, quarters: s.quarters + 1 } : s)) },
      { ...args, stops: [] },
    ];
    for (const m of moved) expect(chargeMatches(m, charge)).toBe(false);
  });

  it("refuse free text, extra keys and fractional cents", () => {
    expect(chargeArgsSchema.safeParse({ ...args, note: "bill them" }).success).toBe(false);
    expect(chargeArgsSchema.safeParse({ ...args, amountCents: 10.5 }).success).toBe(false);
    expect(
      chargeArgsSchema.safeParse({ ...args, stops: [{ ...args.stops[0], arrivedAt: "Monday morning" }] }).success,
    ).toBe(false);
  });
});

describe("detentionDescription", () => {
  it("names the stops and the minutes over free time in fixed words", () => {
    const stop = { dwellMinutes: 0, quarters: 0, cents: cents(0) };
    expect(detentionDescription([{ ...stop, stop: "pickup", overMinutes: 300 }])).toBe(
      "Detention at shipper, 5 h 0 min over free time",
    );
    expect(
      detentionDescription([
        { ...stop, stop: "pickup", overMinutes: 50 },
        { ...stop, stop: "delivery", overMinutes: 25 },
      ]),
    ).toBe("Detention at shipper and consignee, 1 h 15 min over free time");
  });
});
