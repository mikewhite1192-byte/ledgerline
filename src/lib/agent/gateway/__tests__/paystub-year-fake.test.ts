import { describe, expect, it } from "vitest";
import { DEMO_CARRIERS } from "../../../seed/carriers";
import { readPaystubYear } from "../../../settlements/year";
import { localDateOf } from "../../../time/local-date";
import { TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// The seed-plan fake's answer to the paystub year read (settlements/year.ts) keeps the SQL's
// meaning: a paid stub counts only stubs paid up to and including it, in the year it was paid in
// the carrier's zone. The database test proves the SQL itself.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const hero = plan.rows.drivers.find((d) => d.code === DEMO_CARRIERS[0].heroCode)!;
const paid = plan.rows.settlements
  .filter((s) => s.driver_id === hero.id && s.status === "paid" && s.paid_at !== null)
  .sort((a, b) => (a.paid_at! < b.paid_at! ? -1 : 1));
const yearOf = (at: string) => Number(localDateOf(at, zone).slice(0, 4));

describe("the seed plan fake for the paystub year read", () => {
  it("answers an older paid stub with only what was paid up to and including it", async () => {
    expect(paid.length).toBeGreaterThan(1);
    const older = paid[Math.floor((paid.length - 1) / 2)];
    const upTo = paid.filter((s) => s.paid_at! <= older.paid_at! && yearOf(s.paid_at!) === yearOf(older.paid_at!));
    const year = await planDb(plan).withTenant(TENANT, (q) => readPaystubYear(q, older.id));
    expect(year).toEqual({
      yearToDate: {
        year: yearOf(older.paid_at!),
        paidCents: upTo.reduce((n, s) => n + s.net_cents, 0),
        stubs: upTo.length,
        zone,
      },
      escrow: { balanceCents: older.escrow_closing_cents, asOf: "paid" },
    });
  });
});
