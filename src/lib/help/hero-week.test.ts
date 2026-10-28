import { describe, expect, it } from "vitest";
import { configFor } from "@/lib/data/config-version";
import { loadsOf } from "@/lib/data/records";
import { invoiceAmount } from "@/lib/rules-engine";
import { HERO_OPEN_WEEK } from "@/lib/seed/assert-plan";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import golden from "@/lib/seed/golden.json";
import { buildCarrierPlan } from "@/lib/seed/plan";
import {
  EXAMPLE_LOAD,
  HERO_ADVANCE,
  HERO_CARRIER,
  HERO_DRIVER,
  HERO_INSURANCE,
  HERO_LINES,
  HERO_LOADS,
  HERO_PERIOD,
  HERO_STORY,
  HERO_TOTALS,
} from "./hero-week";

// The help page's numbers are constants so the public page reads no records. Each one is held
// equal to the seed here: when the seed moves, this fails before the page can tell a wrong story.

const hero = golden.carriers["blue-ridge"].hero;
const carrier = DEMO_CARRIERS.find((c) => c.slug === "blue-ridge");
if (!carrier || !hero) throw new Error("the hero carrier is missing from the seed");
const plan = buildCarrierPlan(carrier, golden.anchor);
const rows = plan.rows;
const driver = rows.drivers.find((d) => d.code === HERO_DRIVER.code);
if (!driver) throw new Error("the hero driver is missing from the plan");
const openWeek = plan.periods[3];
const config = configFor(rows.pay_configs, openWeek.start);
const loadByNumber = (n: string) => {
  const load = rows.loads.find((l) => l.load_number === n);
  if (!load) throw new Error(`load ${n} is missing from the plan`);
  return load;
};
const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);

describe("the hero week constants", () => {
  it("are golden.json's hero lines, line for line", () => {
    expect(hero.code).toBe(HERO_DRIVER.code);
    expect(HERO_LINES.map((l) => ({ seq: l.seq, kind: l.kind, label: l.engineLabel, amountCents: l.amountCents }))).toEqual(
      hero.lines,
    );
  });

  it("carry the totals golden.json and the seed's own assertion hold", () => {
    expect(HERO_TOTALS).toEqual({ grossCents: hero.grossCents, deductionsCents: hero.deductionsCents, netCents: hero.netCents });
    expect(HERO_TOTALS).toEqual(HERO_OPEN_WEEK);
    expect(sum(HERO_LINES.map((l) => l.amountCents))).toBe(HERO_TOTALS.netCents);
    expect(sum(HERO_LINES.filter((l) => l.amountCents > 0).map((l) => l.amountCents))).toBe(HERO_TOTALS.grossCents);
    expect(sum(HERO_LINES.filter((l) => l.amountCents < 0).map((l) => -l.amountCents))).toBe(HERO_TOTALS.deductionsCents);
  });

  it("name the carrier, the driver and the week the plan has", () => {
    expect(carrier.name).toBe(HERO_CARRIER);
    expect(`${driver.first_name} ${driver.last_name}`).toBe(HERO_DRIVER.name);
    expect(driver.first_name).toBe(HERO_DRIVER.firstName);
    expect(driver.worker_type).toBe(HERO_DRIVER.workerType);
    expect(driver.pay_basis).toBe("percent");
    expect(driver.percent_bps).toBe(HERO_DRIVER.percentOfLinehaul * 100);
    expect(config.percent_base).toBe("linehaul");
    expect({ start: openWeek.start, end: openWeek.end }).toEqual(HERO_PERIOD);
  });

  it("pay each load the stated share of its linehaul, and the loads' sum is the story's", () => {
    const loadLines = HERO_LINES.filter((l) => l.kind === "load_pay");
    expect(loadLines.map((l) => l.engineLabel)).toEqual(HERO_LOADS.map((l) => `Load ${l.loadNumber}`));
    HERO_LOADS.forEach((l, i) => {
      expect(loadByNumber(l.loadNumber).linehaul_cents).toBe(l.linehaulCents);
      expect(loadByNumber(l.loadNumber).driver_id).toBe(driver.id);
      expect(loadLines[i].amountCents).toBe((l.linehaulCents * HERO_DRIVER.percentOfLinehaul) / 100);
    });
    expect(sum(loadLines.map((l) => l.amountCents))).toBe(HERO_STORY.loadPayCents);
    expect(sum(HERO_LINES.filter((l) => l.kind === "reimbursement").map((l) => l.amountCents))).toBe(
      HERO_STORY.reimbursedCents,
    );
  });

  it("charge insurance for the days driven at the week's daily rate", () => {
    const line = HERO_LINES.find((l) => l.kind === "insurance");
    expect(line?.engineLabel).toBe(`Insurance, ${HERO_INSURANCE.days} days`);
    expect(config.insurance_per_day_cents).toBe(HERO_INSURANCE.perDayCents);
    expect(line?.amountCents).toBe(-HERO_INSURANCE.days * HERO_INSURANCE.perDayCents);
  });

  it("take back the advance she asked for that Wednesday", () => {
    const line = HERO_LINES.find((l) => l.kind === "advance_recovery");
    expect(line?.engineLabel).toBe(`Advance recovery (${HERO_ADVANCE.requestedOn})`);
    expect(line?.amountCents).toBe(-HERO_ADVANCE.amountCents);
    const advance = rows.advances.find((a) => a.driver_id === driver.id && a.requested_on === HERO_ADVANCE.requestedOn);
    expect(advance?.amount_cents).toBe(HERO_ADVANCE.amountCents);
    const weekday = new Date(`${HERO_ADVANCE.requestedOn}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });
    expect(weekday).toBe(HERO_ADVANCE.weekday);
  });

  it("bill the example load as the rules engine would invoice it", () => {
    const row = loadByNumber(EXAMPLE_LOAD.loadNumber);
    expect(`${row.origin_city}, ${row.origin_state}`).toBe(EXAMPLE_LOAD.origin);
    expect(`${row.dest_city}, ${row.dest_state}`).toBe(EXAMPLE_LOAD.destination);
    expect(row.loaded_miles).toBe(EXAMPLE_LOAD.loadedMiles);
    expect(row.linehaul_cents).toBe(EXAMPLE_LOAD.linehaulCents);
    expect(row.fuel_surcharge_cents).toBe(EXAMPLE_LOAD.fuelSurchargeCents);
    const [record] = loadsOf(
      [row],
      rows.load_state_miles.filter((m) => m.load_id === row.id),
      rows.load_accessorials.filter((a) => a.load_id === row.id),
    );
    const billed = invoiceAmount(record);
    expect(billed.ok).toBe(true);
    if (!billed.ok) return;
    expect(billed.amountCents).toBe(EXAMPLE_LOAD.invoiceCents);
    expect(billed.lines.map((l) => l.kind)).toEqual(["linehaul", "fuel_surcharge"]);
    expect(EXAMPLE_LOAD.linehaulCents + EXAMPLE_LOAD.fuelSurchargeCents).toBe(EXAMPLE_LOAD.invoiceCents);
  });
});
