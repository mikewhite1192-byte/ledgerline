import { configFor, configForDay } from "../data/config-version";
import {
  advanceOf,
  checkInputOf,
  customerOf,
  driverOf,
  loadStopsOf,
  payConfigOf,
  receivablesInputOf,
  settlementInputOf,
} from "../data/records";
import type { AdvanceRow, DriverRow, TenantRows } from "../data/rows";
import { TENANT_TABLES } from "../data/tables";
import {
  advanceEligibility,
  AGING_BUCKETS,
  agingBucket,
  cents,
  findPaymentOnWrongInvoice,
  findUnbilledDetention,
  invoiceStatus,
  paymentProfile,
  runAllChecks,
  settleDriver,
  sum,
  type AdvanceDecision,
  type LoadRecord,
  type PayConfig,
} from "../rules-engine";
import {
  addDays,
  daysBetween,
  isWithin,
  localDateOf,
  type LocalDate,
  type Period,
} from "../time/local-date";
import { customerClassOf } from "./ar-plan";
import type { CarrierPlan } from "./plan";

// The whole plan is checked before anything is written: keys, references, dates, the history the
// engine wrote, the receivables, and the problems the checks must find (exactly the planted ones,
// nothing more). A plan that fails here never reaches a database.

// The hero's open week, worked by hand in the design (section 3).
export const HERO_OPEN_WEEK = { grossCents: 258000, deductionsCents: 35500, netCents: 222500 };

// Each aging bucket holds at least this many open invoices and this much money.
export const AGING_MIN_INVOICES = 3;
export const AGING_MIN_CENTS = 500000;

// The unbilled detention planted in each tenant's four weeks: $1,350.00.
export const DETENTION_TOTAL_CENTS = 135000;

// The three fuel anomalies (addendum B2), by the rule each one breaks. Each returns the ids of
// the purchases that break it.
export function fuelAnomalyIds(rows: TenantRows): Record<
  "offRoute" | "overTank" | "parked",
  string[]
> {
  const loads = new Map(rows.loads.map((l) => [l.id, l]));
  const tanks = new Map(rows.drivers.map((d) => [d.id, d.tank_gallons]));
  const offRoute = rows.fuel_purchases.filter((f) => {
    const load = f.load_id === null ? undefined : loads.get(f.load_id);
    if (!load || f.purchased_on < load.pickup_on) return false;
    if (load.delivered_on !== null && f.purchased_on > load.delivered_on) return false;
    const states = rows.load_state_miles.filter((m) => m.load_id === load.id).map((m) => m.state);
    return !states.includes(f.state);
  });
  const overTank = rows.fuel_purchases.filter(
    (f) => f.gallons_milli > tanks.get(f.driver_id)! * 1000,
  );
  const parked = rows.fuel_purchases.filter(
    (f) =>
      f.paid_with === "company_card" &&
      !rows.loads.some(
        (l) =>
          l.driver_id === f.driver_id &&
          l.pickup_on <= f.purchased_on &&
          f.purchased_on <= (l.delivered_on ?? f.purchased_on),
      ) &&
      !rows.driver_days.some((d) => d.driver_id === f.driver_id && d.day === f.purchased_on),
  );
  const ids = (list: readonly { id: string }[]) => list.map((x) => x.id);
  return { offRoute: ids(offRoute), overTank: ids(overTank), parked: ids(parked) };
}

// The engine's answer when a seeded advance was asked for. Only loads delivered on or before
// that day count, every earlier week counts as paid, and the advances given count as open.
export type SeededAdvanceArgs = {
  config: PayConfig;
  driver: DriverRow;
  loads: readonly LoadRecord[];
  periods: readonly Period[];
  zone: string;
  at: string;
  amountCents: number;
  prior: readonly AdvanceRow[];
};

export function seededAdvanceDecision(a: SeededAdvanceArgs): AdvanceDecision {
  const on = localDateOf(a.at, a.zone);
  const week = a.periods.findIndex((p) => isWithin(on, p));
  if (week < 0) throw new Error("a seeded advance falls outside the four weeks");
  return advanceEligibility({
    config: a.config,
    driver: driverOf(a.driver),
    amountCents: cents(a.amountCents),
    requestedAt: a.at,
    requestedOn: on,
    loads: a.loads.filter(
      (l) => l.driverId === a.driver.id && l.deliveredOn !== null && l.deliveredOn <= on,
    ),
    paidPeriods: a.periods.slice(0, week),
    advances: a.prior.map(advanceOf),
  });
}

function fail(what: string): never {
  throw new Error(`seed plan: ${what}`);
}

function unique<T>(list: readonly T[], key: (x: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const x of list) {
    const k = key(x);
    if (seen.has(k)) fail(`duplicate ${what}`);
    seen.add(k);
  }
}

function refs<T>(list: readonly T[], ref: (x: T) => string | null, ids: Set<string>, what: string) {
  for (const x of list) {
    const id = ref(x);
    if (id !== null && !ids.has(id)) fail(`${what} names a row the plan does not hold`);
  }
}

const idsOf = (list: readonly { id: string }[]) => new Set(list.map((x) => x.id));

export function assertPlan(plan: CarrierPlan): void {
  const { rows, anchor, periods, victims, planted, carrier } = plan;
  const zone = carrier.timezone;
  const lastDay = addDays(anchor, -1);
  const openWeek = periods[3];
  for (const table of TENANT_TABLES) {
    if (!Array.isArray(rows[table])) fail(`table ${table} is missing`);
  }

  keysAndReferences(rows);
  loadsAndDays(rows, zone, lastDay, openWeek.start);
  receivables(plan, lastDay);
  addendumPlants(plan);

  // Victims: ten distinct drivers, never the hero.
  const codes = Object.values(victims);
  if (new Set(codes).size !== codes.length) fail("two problems share a victim");
  if (carrier.heroCode && codes.includes(carrier.heroCode)) fail("the hero is a victim");

  // History: every driver settled once in each of the three paid weeks, under the pay rules
  // version in force at the week's start.
  if (rows.settlements.length !== rows.drivers.length * 3) fail("history is incomplete");
  if (rows.settlement_periods.filter((p) => p.status === "open").length !== 1) {
    fail("there must be exactly one open week");
  }
  for (const s of rows.settlements) {
    const p = rows.settlement_periods.find((x) => x.id === s.period_id)!;
    if (configFor(rows.pay_configs, p.period_start).id !== s.pay_config_id) {
      fail("a settlement names the wrong pay rules version");
    }
  }

  // The checks find the six planted pay problems and nothing else.
  const driverOfCode = (code: string) => rows.drivers.find((d) => d.code === code)!;
  const expected = [
    `duplicate_advance:${planted.duplicateAdvanceIds[1]}`,
    `fuel_on_wrong_driver:${planted.wrongDriverFuelItemId}`,
    `insurance_day_not_driven:${planted.dispatchDayId}`,
    `missing_reimbursement:${planted.unreimbursedLumperId}`,
    `delivered_without_rate:${planted.noRateLoadId}`,
    `over_advance_limit:${driverOfCode(victims.overLimit).id}`,
  ].sort();
  const found = runAllChecks(checkInputOf(rows))
    .map((f) => `${f.check}:${f.sources[0]?.id}`)
    .sort();
  if (found.join("|") !== expected.join("|")) fail("the pay checks do not find exactly the plants");

  // And the seventh: the one payment on the wrong invoice.
  const w = planted.wrongInvoice;
  const ar = findPaymentOnWrongInvoice(receivablesInputOf(rows, anchor));
  const cited = ar.length === 1 ? ar[0].sources.map((s) => `${s.table}:${s.id}`).join("|") : "";
  const want = [
    `customer_payments:${w.paymentId}`,
    `payment_applications:${w.applicationId}`,
    `invoices:${w.appliedToInvoiceId}`,
    `invoices:${w.meantForInvoiceId}`,
  ].join("|");
  if (ar[0]?.category !== "payment_on_wrong_invoice" || cited !== want) {
    fail("the receivables check does not find exactly the planted payment");
  }

  // Advances: the planted ones stay owed in full; every other one is its driver's only advance
  // and is one the engine grants on the earnings of the day it was asked for.
  const plantedAdvances = new Set([...planted.duplicateAdvanceIds, ...planted.overLimitAdvanceIds]);
  for (const id of plantedAdvances) {
    const a = rows.advances.find((x) => x.id === id);
    if (!a || a.recovered_cents !== 0) fail("a planted advance was recovered");
  }
  const loads = checkInputOf(rows).loads;
  for (const a of rows.advances) {
    if (plantedAdvances.has(a.id)) continue;
    if (rows.advances.filter((x) => x.driver_id === a.driver_id).length !== 1) {
      fail("a driver without a planted problem has two advances");
    }
    const driver = rows.drivers.find((d) => d.id === a.driver_id)!;
    const decision = seededAdvanceDecision({
      config: payConfigOf(configForDay(rows.pay_configs, a.requested_on)),
      driver,
      loads,
      periods,
      zone,
      at: a.requested_at,
      amountCents: a.amount_cents,
      prior: [],
    });
    if (!decision.eligible) fail("a seeded advance is one the engine would refuse");
  }

  // The hero's open week settles to the worked example.
  if (carrier.heroCode) {
    const hero = driverOfCode(carrier.heroCode);
    const r = settleDriver(settlementInputOf(rows, hero.id, openWeek));
    const got = { grossCents: r.grossCents, deductionsCents: r.deductionsCents, netCents: r.netCents };
    if (JSON.stringify(got) !== JSON.stringify(HERO_OPEN_WEEK)) fail("the hero's net moved");
  }
}

function keysAndReferences(rows: TenantRows): void {
  const all = TENANT_TABLES.flatMap((t) => rows[t] as readonly { id: string }[]);
  unique(all, (x) => x.id, "id");
  unique(rows.customers, (x) => x.code, "customer code");
  unique(rows.drivers, (x) => x.code, "driver code");
  unique(rows.drivers, (x) => x.email, "driver email");
  unique(rows.loads, (x) => x.load_number, "load number");
  unique(rows.load_state_miles, (x) => `${x.load_id}:${x.state}`, "load state");
  unique(rows.load_accessorials, (x) => `${x.load_id}:${x.kind}:${x.seq}`, "accessorial");
  unique(rows.driver_days, (x) => `${x.driver_id}:${x.day}`, "driver day");
  unique(rows.fuel_purchases, (x) => x.purchase_ref, "purchase ref");
  unique(rows.deduction_schedules, (x) => `${x.driver_id}:${x.kind}:${x.active_from}`, "schedule");
  unique(rows.settlement_periods, (x) => x.period_start, "period");
  unique(rows.settlements, (x) => `${x.period_id}:${x.driver_id}`, "settlement");
  unique(rows.settlement_lines, (x) => `${x.settlement_id}:${x.seq}`, "settlement line");
  unique(rows.pay_items, (x) => x.item_ref, "item ref");
  unique(rows.advances, (x) => x.request_ref, "request ref");
  unique(rows.invoices.filter((x) => x.load_id !== null), (x) => x.load_id!, "load invoice");
  unique(rows.invoices, (x) => x.invoice_number, "invoice number");
  unique(rows.customer_payments, (x) => x.payment_ref, "payment ref");
  unique(rows.payment_applications, (x) => `${x.payment_id}:${x.invoice_id}`, "application");
  unique(rows.pay_configs, (x) => x.effective_from, "pay config date");
  if (rows.pay_configs.length === 0) fail("a tenant needs a pay config");

  const customers = idsOf(rows.customers);
  const drivers = idsOf(rows.drivers);
  const loads = idsOf(rows.loads);
  refs(rows.loads, (x) => x.customer_id, customers, "a load");
  refs(rows.loads, (x) => x.driver_id, drivers, "a load");
  refs(rows.load_state_miles, (x) => x.load_id, loads, "a state mile row");
  refs(rows.load_accessorials, (x) => x.load_id, loads, "an accessorial");
  refs(rows.driver_days, (x) => x.driver_id, drivers, "a driver day");
  refs(rows.driver_days, (x) => x.load_id, loads, "a driver day");
  refs(rows.fuel_purchases, (x) => x.driver_id, drivers, "a fuel purchase");
  refs(rows.fuel_purchases, (x) => x.load_id, loads, "a fuel purchase");
  refs(rows.deduction_schedules, (x) => x.driver_id, drivers, "a schedule");
  refs(rows.settlements, (x) => x.period_id, idsOf(rows.settlement_periods), "a settlement");
  refs(rows.settlements, (x) => x.driver_id, drivers, "a settlement");
  refs(rows.settlements, (x) => x.pay_config_id, idsOf(rows.pay_configs), "a settlement");
  refs(rows.settlement_lines, (x) => x.settlement_id, idsOf(rows.settlements), "a line");
  refs(rows.pay_items, (x) => x.driver_id, drivers, "a pay item");
  refs(rows.pay_items, (x) => x.settlement_id, idsOf(rows.settlements), "a pay item");
  refs(rows.advances, (x) => x.driver_id, drivers, "an advance");
  refs(rows.invoices, (x) => x.customer_id, customers, "an invoice");
  refs(rows.invoices, (x) => x.load_id, loads, "an invoice");
  refs(rows.customer_payments, (x) => x.customer_id, customers, "a payment");
  refs(rows.payment_applications, (x) => x.payment_id, idsOf(rows.customer_payments), "an application");
  refs(rows.payment_applications, (x) => x.invoice_id, idsOf(rows.invoices), "an application");

  // A pay item's reference points at a row of the table it names.
  const byTable: Record<string, Set<string>> = {
    fuel_purchases: idsOf(rows.fuel_purchases),
    load_accessorials: idsOf(rows.load_accessorials),
    loads,
    settlements: idsOf(rows.settlements),
  };
  for (const i of rows.pay_items) {
    if ((i.ref_table === null) !== (i.ref_id === null)) fail("a pay item has half a reference");
    if (i.ref_table !== null && !byTable[i.ref_table].has(i.ref_id!)) {
      fail("a pay item references a row the plan does not hold");
    }
    if (i.kind === "fuel" && i.ref_table !== "fuel_purchases") fail("a fuel item has no purchase");
  }
  // Every line source names a row the plan holds.
  const known = new Set(all.map((x) => x.id));
  for (const line of rows.settlement_lines) {
    if (line.sources.some((s) => !known.has(s.id))) fail("a settlement line cites a missing row");
  }
}

function loadsAndDays(
  rows: TenantRows,
  zone: string,
  lastDay: LocalDate,
  openStart: LocalDate,
): void {
  const miles = new Map<string, number>();
  for (const m of rows.load_state_miles) {
    if (!/^[A-Z]{2}$/.test(m.state) || m.miles <= 0) fail("a state mile row is malformed");
    miles.set(m.load_id, (miles.get(m.load_id) ?? 0) + m.miles);
  }
  for (const l of rows.loads) {
    if (miles.get(l.id) !== l.loaded_miles + l.empty_miles) fail("state miles do not add up");
    if (l.pickup_on > lastDay) fail("a load starts after the last seeded day");
    const times = [
      l.pickup_arrived_at,
      l.pickup_departed_at,
      l.delivery_arrived_at,
      l.delivery_departed_at,
    ];
    if (l.status === "in_transit") {
      if (l.delivered_on !== null || l.delivered_at !== null) fail("an in-transit load is delivered");
      if (times.some((t) => t !== null)) fail("an in-transit load has stop times");
      continue;
    }
    if (l.delivered_on === null || l.delivered_at === null || l.driver_id === null) {
      fail("a delivered load lacks a date or a driver");
    }
    if (localDateOf(l.delivered_at, zone) !== l.delivered_on) fail("a delivery date is off");
    if (l.delivered_on < l.pickup_on || l.delivered_on > lastDay) fail("a delivery is out of range");
    // Stop times: all four or none (none only in the open week), in order, the delivery
    // departure at the signed delivery, the pickup arrival and departure on the pickup day, and
    // some drive time between leaving pickup and arriving at delivery.
    if (times.every((t) => t === null)) {
      if (l.delivered_on < openStart) fail("a settled-week load has no stop times");
      continue;
    }
    if (times.some((t) => t === null)) fail("a load has only some stop times");
    const ms = times.map((t) => Date.parse(t!));
    if (ms.some((m, i) => Number.isNaN(m) || (i > 0 && m < ms[i - 1]))) {
      fail("stop times are out of order");
    }
    if (ms[3] !== Date.parse(l.delivered_at)) fail("the delivery departure is not the delivery");
    if (localDateOf(l.pickup_departed_at!, zone) !== l.pickup_on) fail("a pickup is off its day");
    if (localDateOf(l.pickup_arrived_at!, zone) !== l.pickup_on) {
      fail("a pickup arrival is off its day");
    }
    if (ms[2] <= ms[1]) fail("a load has no drive time");
  }
  for (const f of rows.fuel_purchases) {
    if (localDateOf(f.purchased_at, zone) !== f.purchased_on) fail("a purchase date is off");
    if (f.purchased_on > lastDay || !Number.isInteger(f.gallons_milli)) fail("a purchase is off");
  }
  for (const a of rows.advances) {
    if (localDateOf(a.requested_at, zone) !== a.requested_on) fail("an advance date is off");
    if (a.requested_on > lastDay) fail("an advance is after the last seeded day");
  }
  if (rows.driver_days.some((d) => d.day > lastDay)) fail("a driver day is after the last day");
}

function receivables(plan: CarrierPlan, lastDay: LocalDate): void {
  const { rows, anchor, periods } = plan;
  const invoices = new Map(rows.invoices.map((i) => [i.id, i]));
  const payments = new Map(rows.customer_payments.map((p) => [p.id, p]));
  const applied = new Map<string, { cents: number; on: LocalDate }>();
  const perPayment = new Map<string, number>();
  for (const a of rows.payment_applications) {
    const invoice = invoices.get(a.invoice_id)!;
    const payment = payments.get(a.payment_id)!;
    if (invoice.customer_id !== payment.customer_id) fail("a payment is applied across customers");
    if (payment.received_on < invoice.issued_on) fail("a payment arrived before its invoice");
    perPayment.set(payment.id, (perPayment.get(payment.id) ?? 0) + a.amount_cents);
    const before = applied.get(invoice.id);
    applied.set(invoice.id, {
      cents: (before?.cents ?? 0) + a.amount_cents,
      on: before && before.on > payment.received_on ? before.on : payment.received_on,
    });
  }
  for (const p of rows.customer_payments) {
    if ((perPayment.get(p.id) ?? 0) > p.amount_cents) fail("a payment is applied past its amount");
    if (p.received_on > lastDay) fail("a payment is after the last seeded day");
  }
  let overapplied = 0;
  const open = new Map(AGING_BUCKETS.map((b) => [b, { count: 0, cents: 0 }]));
  for (const i of rows.invoices) {
    if (i.issued_on > lastDay) fail("an invoice is after the last seeded day");
    if (daysBetween(i.issued_on, i.due_on) < 0) fail("an invoice is due before it was issued");
    const a = applied.get(i.id);
    const status = invoiceStatus(i.amount_cents, a?.cents ?? 0);
    if (status.status !== i.status) fail("an invoice status does not follow its payments");
    if ((i.status === "paid" ? a!.on : null) !== i.paid_on) fail("an invoice paid date is off");
    if (status.overappliedCents > 0) overapplied++;
    if (status.balanceCents > 0) {
      const bucket = open.get(agingBucket(i.due_on, anchor))!;
      bucket.count++;
      bucket.cents += status.balanceCents;
    }
  }
  if (overapplied !== 1) fail("exactly one invoice should be overapplied");
  for (const [name, b] of open) {
    if (b.count < AGING_MIN_INVOICES || b.cents < AGING_MIN_CENTS) {
      fail(`aging bucket ${name} holds ${b.count} invoices, ${b.cents} cents`);
    }
  }
  const inOpenWeek = rows.customer_payments.filter((p) => isWithin(p.received_on, periods[3]));
  if (inOpenWeek.length < 5) fail("too few payments arrived in the open week");
}

// The addendum B plants: the three fuel anomalies each found by exactly its rule, the unbilled
// detention exactly the four planted loads and $1,350.00 over the four weeks, the payment styles
// read back from the history, and the collections invoices open at their ages.
function addendumPlants(plan: CarrierPlan): void {
  const { rows, anchor, periods, planted, carrier } = plan;
  const fuel = fuelAnomalyIds(rows);
  if (
    fuel.offRoute.join() !== planted.fuelOffRouteId ||
    fuel.overTank.join() !== planted.fuelOverTankId ||
    fuel.parked.join() !== planted.fuelParkedId
  ) {
    fail("the fuel rules do not find exactly the planted purchases");
  }
  const tank = rows.fuel_purchases.find((f) => f.id === planted.fuelOverTankId)!;
  if (!rows.pay_items.some((i) => i.ref_table === "fuel_purchases" && i.ref_id === tank.id)) {
    fail("the fill over the tank was not deducted");
  }

  const unbilled = findUnbilledDetention(
    rows.loads.map(loadStopsOf),
    rows.customers.map(customerOf),
    rows.load_accessorials.map((a) => ({ loadId: a.load_id, kind: a.kind })),
    { start: periods[0].start, end: periods[3].end },
  );
  const found = unbilled.map((u) => u.loadId).sort();
  if (
    found.join() !== [...planted.detentionLoadIds].sort().join() ||
    sum(unbilled.map((u) => u.amountCents)) !== DETENTION_TOTAL_CENTS
  ) {
    fail("unbilled detention is not exactly the four plants");
  }
  for (const id of planted.detentionLoadIds) {
    const invoice = rows.invoices.find((i) => i.load_id === id);
    if (invoice?.status !== "open") fail("a detention load's invoice is not open");
  }

  const input = receivablesInputOf(rows, anchor);
  rows.customers.forEach((c, i) => {
    const style = customerClassOf(i);
    if (style === "typical") return;
    const { label } = paymentProfile(c.id, input, anchor);
    if (label !== (style === "prompt" ? "reliable" : "repeat_late")) {
      fail(`${style} payer ${c.code} reads as ${label}`);
    }
  });
  for (const k of planted.collections) {
    const invoice = rows.invoices.find((i) => i.id === k.invoiceId);
    if (invoice?.status !== "open" || daysBetween(invoice.due_on, anchor) !== k.daysLate) {
      fail("a collections invoice is not open at its age");
    }
  }

  // Nothing new is planted on the hero.
  const hero = carrier.heroCode ? rows.drivers.find((d) => d.code === carrier.heroCode)! : null;
  if (hero) {
    const fuelIds = [planted.fuelOffRouteId, planted.fuelOverTankId, planted.fuelParkedId];
    const onHero = (loadId: string) =>
      rows.loads.find((l) => l.id === loadId)?.driver_id === hero.id;
    if (
      rows.fuel_purchases.some((f) => fuelIds.includes(f.id) && f.driver_id === hero.id) ||
      planted.detentionLoadIds.some(onHero)
    ) {
      fail("a new plant landed on the hero");
    }
  }
}
