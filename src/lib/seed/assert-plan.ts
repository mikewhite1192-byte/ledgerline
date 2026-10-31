import { flags } from "../../config/flags";
import { configFor, configForDay } from "../data/config-version";
import {
  advanceOf,
  checkInputOf,
  customerOf,
  driverOf,
  loadsOf,
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
  findFuelDuplicate,
  findFuelOffRoute,
  findFuelOverTank,
  findFuelWhileParked,
  findPaymentOnWrongInvoice,
  findUnbilledDetention,
  inReviewQueue,
  invoiceAmount,
  invoiceStatus,
  paymentProfile,
  reviewInvoice,
  runAllChecks,
  settleDriver,
  sum,
  type AdvanceDecision,
  type Cents,
  type FuelFinding,
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
import { reviewFactsOf, reviewInputOf } from "../invoices/review-input";
import { customerClassOf } from "./ar-plan";
import { rankCandidates, reconcileStatement, topIsTied } from "../rules-engine/card-recon";
import { PLANT_FUEL_EXTRA_CENTS, PLANT_LOAD_CENTS, PLANT_UNKNOWN_CENTS, STATEMENT_DAYS } from "./card-statement";
import { cashPositionOf, plantedGapCents } from "./cash-plan";
import type { CarrierPlan } from "./plan";
import { DEPARTED_WEEKS } from "./terminated-plan";

// The whole plan is checked before anything is written: keys, references, dates, the history the
// engine wrote, the receivables, and the problems the checks must find (exactly the planted ones,
// nothing more). A plan that fails here never reaches a database.

// The hero's open week, worked by hand in the design (section 3).
export const HERO_OPEN_WEEK = { grossCents: 258000, deductionsCents: 35500, netCents: 222500 };

// Each aging bucket holds at least this many open invoices and this much money.
export const AGING_MIN_INVOICES = 3;
export const AGING_MIN_CENTS = 500000;

// The unbilled detention planted in each tenant's four weeks: $2,375.00.
export const DETENTION_TOTAL_CENTS = 237500;

// The demo's numbers, each the engine's answer for the planted inputs: the duplicate advance
// the sweep pays back, the off-route fill-up it charges back, and the billed detention the
// customer short-paid (acme-plan.ts), which is exactly what the invoice still owes.
export const DUPLICATE_ADVANCE_CENTS = 20000;
export const OFF_ROUTE_FUEL_CENTS = 41200;
export const DISPUTED_DETENTION_CENTS = 180000;

// The four fuel anomalies (addendum B2 and FUEL-ANOMALY), found by the engine's own fuel rules.
// Each returns the ids of the purchases at fault (the newer of a duplicate pair).
export function fuelAnomalyIds(rows: TenantRows): Record<
  "offRoute" | "overTank" | "parked" | "duplicate",
  string[]
> {
  const input = checkInputOf(rows);
  const ids = (list: readonly FuelFinding[]) => list.map((f) => f.fuelPurchaseId);
  return {
    offRoute: ids(findFuelOffRoute(input)),
    overTank: ids(findFuelOverTank(input)),
    parked: ids(findFuelWhileParked(input)),
    duplicate: ids(findFuelDuplicate(input, flags.fuelAnomalyLimits.duplicateWindowMinutes)),
  };
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
  // The load the advance is for, with the driver's pay on it, when it names one.
  load?: { id: string; payCents: Cents } | null;
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
    load: a.load ?? null,
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
  driverCards(rows, carrier.heroCode);
  parityPlants(plan);
  loadsAndDays(rows, zone, lastDay, openWeek.start);
  receivables(plan, lastDay);
  addendumPlants(plan);
  demoNumbers(plan);
  cashFriday(plan);
  invoiceReviewPlants(plan);
  cardStatementPlants(plan);
  departedDriver(plan);

  // Victims: eleven distinct drivers, never the hero.
  const codes = Object.values(victims);
  if (new Set(codes).size !== codes.length) fail("two problems share a victim");
  if (carrier.heroCode && codes.includes(carrier.heroCode)) fail("the hero is a victim");

  // History: every driver on the roster settled once in each of the three paid demo weeks, the
  // departed driver once in each of their old weeks, nobody in a week they were not active in,
  // and each under the pay rules version in force at the week's start.
  const roster = rows.drivers.filter((d) => d.active_to === null);
  if (rows.settlements.length !== roster.length * 3 + DEPARTED_WEEKS) fail("history is incomplete");
  if (rows.settlement_periods.filter((p) => p.status === "open").length !== 1) {
    fail("there must be exactly one open week");
  }
  for (const s of rows.settlements) {
    const p = rows.settlement_periods.find((x) => x.id === s.period_id)!;
    if (configFor(rows.pay_configs, p.period_start).id !== s.pay_config_id) {
      fail("a settlement names the wrong pay rules version");
    }
    const d = rows.drivers.find((x) => x.id === s.driver_id)!;
    if (d.active_from > p.period_end || (d.active_to !== null && d.active_to < p.period_start)) {
      fail("a driver is settled in a week they were not active");
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
  const plantedAdvances = new Set([
    ...planted.duplicateAdvanceIds,
    ...planted.overLimitAdvanceIds,
    ...planted.parity.loadPairAdvanceIds,
  ]);
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

  // MONEY-CODE's sample: on the road in the open week, not the hero's, driven by an armed driver,
  // with no lumper line.
  if (carrier.heroCode && planted.moneyCodeLoadId !== null) {
    const load = rows.loads.find((l) => l.id === planted.moneyCodeLoadId);
    if (!load || load.status !== "in_transit") fail("the money code load is not on the road");
    if (load.driver_id === driverOfCode(carrier.heroCode).id) fail("the money code load is the hero's");
    if (!rows.drivers.some((d) => d.id === load.driver_id && d.money_armed)) {
      fail("the money code load's driver is not armed for money");
    }
    if (!isWithin(load.pickup_on, openWeek)) fail("the money code load is not in the open week");
    if (rows.load_accessorials.some((a) => a.load_id === load.id && a.kind === "lumper")) {
      fail("the money code load already has a lumper line");
    }
  } else if (!carrier.heroCode && planted.moneyCodeLoadId !== null) {
    fail("a carrier with no hero plants no money code load");
  }

  // The hero's open week settles to the worked example.
  if (carrier.heroCode) {
    const hero = driverOfCode(carrier.heroCode);
    const r = settleDriver(settlementInputOf(rows, hero.id, openWeek));
    const got = { grossCents: r.grossCents, deductionsCents: r.deductionsCents, netCents: r.netCents };
    if (JSON.stringify(got) !== JSON.stringify(HERO_OPEN_WEEK)) fail("the hero's net moved");
  }
}

// Fuel cards: one default active card per driver, a default never closed, every card naming a
// driver in the plan, tokens and last four unique, a generic card always carrying a portal name,
// the hero holding exactly one card and it plain "ok", and exactly one planted declined and one
// slow card.
function driverCards(rows: TenantRows, heroCode: string | null): void {
  const cards = rows.driver_cards;
  const driverIds = new Set(rows.drivers.map((d) => d.id));
  refs(cards, (c) => c.driver_id, driverIds, "a fuel card");
  unique(cards, (c) => c.provider_token, "card token");
  unique(cards, (c) => c.last4, "card last four");
  const defaults = cards.filter((c) => c.is_default);
  if (defaults.some((c) => c.status !== "active")) fail("a default card is not active");
  unique(defaults, (c) => c.driver_id, "default card per driver");
  // Every driver on the roster holds a default; the departed driver's card is closed.
  const roster = new Set(rows.drivers.filter((d) => d.active_to === null).map((d) => d.id));
  if (defaults.length !== roster.size || defaults.some((c) => !roster.has(c.driver_id))) {
    fail("a driver has no default fuel card");
  }
  for (const c of cards) {
    if (!/^fcs_card_[0-9a-f]{24}$/.test(c.provider_token) || !/^[0-9]{4}$/.test(c.last4)) {
      fail("a fuel card is malformed");
    }
    if (c.sim_behavior === "offline") fail("the seed plants an offline card");
    if (c.holder_kind === "generic" && (c.portal_name === null || !/^[A-Z0-9 -]{2,40}$/.test(c.portal_name))) {
      fail("a generic card has no portal name");
    }
    if ((c.status === "closed") !== (c.closed_at !== null)) fail("a card's closed time is off");
  }
  const count = (b: string) => cards.filter((c) => c.sim_behavior === b).length;
  if (count("declined") !== 1 || count("slow") !== 1) fail("the planted fuel cards are not one declined and one slow");
  if (heroCode) {
    const hero = rows.drivers.find((d) => d.code === heroCode);
    const own = hero ? cards.filter((c) => c.driver_id === hero.id) : [];
    if (own.length !== 1 || !own[0].is_default || own[0].sim_behavior !== "ok") {
      fail("the hero does not hold exactly one plain card");
    }
  }
}

// Advance parity (0027): exactly one driver disarmed (not the hero, no advance), every driver on
// the arming log once and as they stand, one dispatch-system id per driver, every advance's load
// the same driver's, the planted pair on one load and under its cap, the take-back whole.
function parityPlants(plan: CarrierPlan): void {
  const { rows, planted, carrier } = plan;
  const p = planted.parity;
  const disarmed = rows.drivers.filter((d) => !d.money_armed);
  if (disarmed.length !== 1 || disarmed[0].id !== p.disarmedDriverId) fail("not exactly one disarmed driver");
  if (disarmed[0].code === carrier.heroCode) fail("the hero is disarmed");
  if (disarmed[0].money_armed_at !== null) fail("the disarmed driver has an armed time");
  if (rows.advances.some((a) => a.driver_id === p.disarmedDriverId)) fail("the disarmed driver has an advance");
  if (rows.drivers.some((d) => d.money_armed && d.money_armed_at === null)) fail("an armed driver has no armed time");
  const events = rows.driver_arm_events;
  unique(events, (e) => e.driver_id, "arm event per driver");
  if (events.length !== rows.drivers.length) fail("a driver is missing from the arming log");
  for (const e of events) {
    const d = rows.drivers.find((x) => x.id === e.driver_id);
    if (!d || d.money_armed !== e.armed || e.source !== "seed" || e.membership_id !== null) {
      fail("an arming log row does not match its driver");
    }
  }
  const tms = rows.driver_identities;
  unique(tms, (x) => x.driver_id, "dispatch id per driver");
  unique(tms, (x) => x.external_id, "dispatch id");
  if (tms.length !== rows.drivers.length) fail("a driver has no dispatch id");
  // TMS-<carrier prefix>-<five digits>, compared as a fixed head and a fixed-shape tail.
  const head = `TMS-${carrier.prefix}-`;
  if (tms.some((x) => !x.external_id.startsWith(head) || !/^[0-9]{5}$/.test(x.external_id.slice(head.length)))) {
    fail("a dispatch id is malformed");
  }
  for (const a of rows.advances) {
    if (a.load_id === null) continue;
    const load = rows.loads.find((l) => l.id === a.load_id);
    if (!load || load.driver_id !== a.driver_id) fail("an advance names another driver's load");
  }
  const pair = p.loadPairAdvanceIds.map((id) => rows.advances.find((a) => a.id === id));
  if (pair.some((a) => !a || a.load_id !== p.loadPairLoadId || a.driver_id !== pair[0]!.driver_id)) {
    fail("the load pair does not share one load");
  }
  if (pair[0]!.amount_cents === pair[1]!.amount_cents) fail("the load pair repeats an amount");
  const back = rows.advances.find((a) => a.id === p.takenBackAdvanceId);
  if (
    !back ||
    back.status !== "paid" ||
    back.recovered_cents !== 0 ||
    back.taken_back_cents !== back.amount_cents ||
    back.takeback_reason !== "wrong_driver" ||
    back.taken_back_at === null ||
    back.taken_back_by_membership_id !== null
  ) {
    fail("the planted take-back is not whole");
  }
  const takenBack = rows.advances.filter((a) => a.taken_back_cents > 0 || a.taken_back_at !== null);
  if (takenBack.length !== 1) fail("more than the planted advance was taken back");
  if (carrier.heroCode) {
    const generic = rows.driver_cards.filter((c) => c.holder_kind === "generic");
    if (generic.length !== 1 || generic[0].id !== p.genericCardId) fail("not exactly one generic card");
    const closed = rows.driver_cards.find((c) => c.id === p.closedCardId);
    if (!closed || closed.status !== "closed" || closed.is_default) fail("the planted closed card is off");
    const extra = rows.driver_cards.find((c) => c.id === p.extraCardId);
    if (!extra || extra.status !== "active" || extra.is_default) fail("the planted extra card is off");
  }
}

// The departed driver (terminated-plan.ts): exactly one driver has left, before the first demo
// week; nothing of theirs is dated after they left (no loads, days, items, advances, fuel or card
// lines); their settlements are their old weeks only, paid, back to back and before the demo
// weeks; their card is closed and not a default; and their balance is exactly what those paid
// weeks withheld, the full step each week, so their escrow statement matches.
function departedDriver(plan: CarrierPlan): void {
  const { rows, periods } = plan;
  const gone = rows.drivers.filter((d) => d.active_to !== null);
  if (gone.length !== 1) fail("not exactly one departed driver");
  const d = gone[0];
  const left = d.active_to!;
  if (left >= periods[0].start) fail("the departed driver left inside the demo weeks");
  if (rows.loads.some((l) => l.driver_id === d.id && (l.pickup_on > left || (l.delivered_on ?? left) > left))) {
    fail("the departed driver has a load after leaving");
  }
  const holds = (list: readonly { driver_id: string | null }[]) => list.some((x) => x.driver_id === d.id);
  if (holds(rows.driver_days) || holds(rows.pay_items) || holds(rows.advances) || holds(rows.fuel_purchases)) {
    fail("the departed driver has days, items, advances or fuel");
  }
  const cards = rows.driver_cards.filter((c) => c.driver_id === d.id);
  if (cards.length === 0 || cards.some((c) => c.status !== "closed" || c.is_default)) {
    fail("the departed driver's card is not closed");
  }
  for (const c of cards) {
    if (c.closed_at === null || localDateOf(c.closed_at, plan.carrier.timezone) <= left) {
      fail("the departed driver's card closed before they left");
    }
  }
  const tokens = new Set(cards.map((c) => c.provider_token));
  if (rows.card_transactions.some((x) => tokens.has(x.card_token))) fail("the departed driver's card has statement lines");

  const own = rows.settlements.filter((s) => s.driver_id === d.id);
  const weeks = own
    .map((s) => rows.settlement_periods.find((p) => p.id === s.period_id)!)
    .sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
  if (own.length !== DEPARTED_WEEKS || own.some((s) => s.status !== "paid")) {
    fail("the departed driver is not paid for each old week");
  }
  weeks.forEach((p, i) => {
    if (p.status !== "paid" || p.period_end > left || p.period_end >= periods[0].start) {
      fail("a departed driver's week is not an old paid week");
    }
    if (i > 0 && p.period_start !== addDays(weeks[i - 1].period_end, 1)) fail("the old weeks are not back to back");
  });
  const schedule = rows.deduction_schedules.filter((x) => x.driver_id === d.id);
  if (schedule.length !== 1 || schedule[0].kind !== "escrow" || schedule[0].active_to !== left) {
    fail("the departed driver's escrow schedule is off");
  }
  const withheld = sum(own.map((s) => s.escrow_withheld_cents));
  const charged = sum(own.map((s) => s.escrow_charges_cents));
  if (d.escrow_balance_cents !== withheld - charged || charged !== 0) {
    fail("the departed driver's balance is not what their weeks withheld");
  }
  if (withheld !== DEPARTED_WEEKS * schedule[0].amount_cents) fail("an old week did not withhold the full step");
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
  unique(rows.load_events, (x) => `${x.load_id}:${x.to_status}`, "load move");
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
  unique(rows.untrusted_inputs, (x) => x.seed_key ?? x.id, "untrusted seed key");
  unique(rows.screenings, (x) => `${x.content_hash}:${x.screener_version}`, "screening key");
  unique(rows.vendor_bills, (x) => x.bill_ref, "bill ref");
  if (rows.tms_connections.length > 1) fail("a tenant has one dispatch connection at most");
  unique(rows.tms_parties, (x) => `${x.kind}:${x.external_id}`, "dispatch party");
  unique(rows.tms_loads, (x) => x.external_id, "dispatch load");
  unique(rows.tms_loads.filter((x) => x.load_id !== null), (x) => x.load_id!, "dispatch load link");
  unique(rows.tms_stops, (x) => `${x.tms_load_id}:${x.ordinal}`, "dispatch stop");
  unique(rows.tms_status_events, (x) => x.external_event_id, "dispatch event");
  unique(rows.tms_line_items, (x) => x.external_id, "dispatch line");
  unique(rows.tms_documents, (x) => x.external_id, "dispatch document");
  if (rows.tms_status_events.some((x) => !x.seeded) || rows.tms_loads.some((x) => !x.seeded)) {
    fail("a dispatch snapshot row is not marked seeded");
  }
  if (rows.pay_configs.length === 0) fail("a tenant needs a pay config");

  const customers = idsOf(rows.customers);
  const drivers = idsOf(rows.drivers);
  const loads = idsOf(rows.loads);
  refs(rows.loads, (x) => x.customer_id, customers, "a load");
  refs(rows.loads, (x) => x.driver_id, drivers, "a load");
  refs(rows.load_state_miles, (x) => x.load_id, loads, "a state mile row");
  refs(rows.load_accessorials, (x) => x.load_id, loads, "an accessorial");
  refs(rows.load_events, (x) => x.load_id, loads, "a load move");
  refs(rows.tms_parties, (x) => x.customer_id, customers, "a dispatch party");
  refs(rows.tms_parties, (x) => x.driver_id, drivers, "a dispatch party");
  refs(rows.tms_loads, (x) => x.load_id, loads, "a dispatch load");
  const tmsLoads = idsOf(rows.tms_loads);
  refs(rows.tms_stops, (x) => x.tms_load_id, tmsLoads, "a dispatch stop");
  refs(rows.tms_status_events, (x) => x.tms_load_id, tmsLoads, "a dispatch event");
  refs(rows.tms_line_items, (x) => x.tms_load_id, tmsLoads, "a dispatch line");
  refs(rows.tms_documents, (x) => x.tms_load_id, tmsLoads, "a dispatch document");
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
  refs(rows.untrusted_inputs, (x) => x.driver_id, drivers, "an untrusted input");
  refs(rows.screenings, (x) => x.input_id, idsOf(rows.untrusted_inputs), "a screening");
  // A note names a customer, a driver or nobody (the whole carrier), and the seed's are active.
  for (const n of rows.carrier_notes) {
    const pool = n.subject_kind === "customer" ? customers : n.subject_kind === "driver" ? drivers : null;
    if ((pool === null) !== (n.subject_id === null)) fail("a carrier note has half a subject");
    if (pool !== null && !pool.has(n.subject_id!)) fail("a carrier note names a subject the plan does not hold");
    if (n.status !== "active" || n.created_by_kind !== "seed") fail("a seeded carrier note is not an active sample");
  }

  // A pay item's reference points at a row of the table it names.
  const byTable: Record<string, Set<string>> = {
    fuel_purchases: idsOf(rows.fuel_purchases),
    load_accessorials: idsOf(rows.load_accessorials),
    loads,
    settlements: idsOf(rows.settlements),
  };
  for (const i of rows.pay_items) {
    if ((i.ref_table === null) !== (i.ref_id === null)) fail("a pay item has half a reference");
    if (i.ref_table !== null && !byTable[i.ref_table]?.has(i.ref_id!)) {
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

// The addendum B plants: the four fuel anomalies each found by exactly its rule, the unbilled
// detention exactly the three planted loads and $2,375.00 over the four weeks, the payment styles
// read back from the history, and the collections invoices open at their ages.
function addendumPlants(plan: CarrierPlan): void {
  const { rows, anchor, periods, planted, carrier } = plan;
  const fuel = fuelAnomalyIds(rows);
  if (
    fuel.offRoute.join() !== planted.fuelOffRouteId ||
    fuel.overTank.join() !== planted.fuelOverTankId ||
    fuel.parked.join() !== planted.fuelParkedId ||
    fuel.duplicate.join() !== planted.fuelDuplicateIds[1]
  ) {
    fail("the fuel rules do not find exactly the planted purchases");
  }
  const tank = rows.fuel_purchases.find((f) => f.id === planted.fuelOverTankId)!;
  if (!rows.pay_items.some((i) => i.ref_table === "fuel_purchases" && i.ref_id === tank.id)) {
    fail("the fill over the tank was not deducted");
  }
  // The duplicate: both fill-ups paid back to the driver, and the wrong-driver purchase breaks
  // none of the four fuel rules.
  const paidBack = planted.fuelDuplicatePaybackIds.map((id) => rows.pay_items.find((i) => i.id === id));
  if (
    paidBack.some((i, k) => i?.kind !== "reimbursement" || i.ref_id !== planted.fuelDuplicateIds[k])
  ) {
    fail("the duplicate fill-ups were not each paid back");
  }
  if (Object.values(fuel).some((list) => list.includes(planted.wrongDriverPurchaseId))) {
    fail("the wrong-driver purchase breaks a fuel rule");
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
    fail("unbilled detention is not exactly the three plants");
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
    const fuelIds = [
      planted.fuelOffRouteId,
      planted.fuelOverTankId,
      planted.fuelParkedId,
      ...planted.fuelDuplicateIds,
    ];
    const onHero = (loadId: string) =>
      rows.loads.find((l) => l.id === loadId)?.driver_id === hero.id;
    if (
      rows.fuel_purchases.some((f) => fuelIds.includes(f.id) && f.driver_id === hero.id) ||
      [...planted.detentionLoadIds, planted.disputedDetention.loadId].some(onHero)
    ) {
      fail("a new plant landed on the hero");
    }
  }
}

// The demo's numbers from the engine itself. The duplicate advance: the check names the planted
// newer one, on its victim, at its amount (the demo week's two recoveries are pinned in
// plan.test). The off-route fill-up: the fuel rule names the planted purchase, on its victim, and
// charges back the whole of it. The disputed detention: one detention line on the load at the
// engine's amount for its stop times, the invoice at the engine's amount for the load, and one
// short payment that leaves the invoice partly paid with exactly the detention owed.
function demoNumbers(plan: CarrierPlan): void {
  const { rows, periods, planted, victims } = plan;
  const input = checkInputOf(rows);
  const victimId = (code: string) => rows.drivers.find((d) => d.code === code)?.id;
  const dup = runAllChecks(input).filter((f) => f.check === "duplicate_advance");
  if (
    dup.length !== 1 ||
    dup[0].amountCents !== DUPLICATE_ADVANCE_CENTS ||
    dup[0].sources[0]?.table !== "advances" ||
    dup[0].sources[0]?.id !== planted.duplicateAdvanceIds[1] ||
    dup[0].driverId === undefined ||
    dup[0].driverId !== victimId(victims.duplicateAdvance)
  ) {
    fail("the duplicate advance is not the planted one at the planted amount");
  }
  const offRoute = findFuelOffRoute(input);
  if (
    offRoute.length !== 1 ||
    offRoute[0].suggestedCents !== -OFF_ROUTE_FUEL_CENTS ||
    offRoute[0].fuelPurchaseId !== planted.fuelOffRouteId ||
    offRoute[0].driverId !== victimId(victims.fuelOffRoute)
  ) {
    fail("the off-route fill-up is not the planted one at the planted amount");
  }

  const d = planted.disputedDetention;
  const load = rows.loads.find((l) => l.id === d.loadId);
  const customer = rows.customers.find((c) => c.id === load?.customer_id);
  const lines = rows.load_accessorials.filter((a) => a.load_id === d.loadId);
  const charge = lines.find((a) => a.id === d.accessorialId);
  if (!load || !customer || lines.length !== 1 || charge?.kind !== "detention") {
    fail("the disputed load does not carry exactly its detention line");
  }
  const earned = findUnbilledDetention(
    [loadStopsOf(load)],
    [customerOf(customer)],
    [],
    { start: periods[0].start, end: periods[3].end },
  );
  if (
    earned.length !== 1 ||
    earned[0].amountCents !== charge.amount_cents ||
    charge.amount_cents !== DISPUTED_DETENTION_CENTS
  ) {
    fail("the disputed detention is not the engine's amount for the stop times");
  }
  const record = loadsOf([load], rows.load_state_miles, rows.load_accessorials)[0];
  const billed = invoiceAmount(record);
  const invoice = rows.invoices.find((i) => i.id === d.invoiceId);
  if (!billed.ok || invoice?.load_id !== load.id || invoice.amount_cents !== billed.amountCents) {
    fail("the disputed invoice is not the engine's amount for the load");
  }
  const apps = rows.payment_applications.filter((a) => a.invoice_id === invoice.id);
  const payment = rows.customer_payments.find((p) => p.id === d.paymentId);
  if (
    apps.length !== 1 ||
    apps[0].id !== d.applicationId ||
    apps[0].payment_id !== payment?.id ||
    payment.amount_cents !== apps[0].amount_cents ||
    payment.customer_id !== customer.id
  ) {
    fail("the disputed invoice is not paid by exactly its short payment");
  }
  const status = invoiceStatus(invoice.amount_cents, apps[0].amount_cents);
  if (
    invoice.status !== "partially_paid" ||
    status.status !== "partially_paid" ||
    status.balanceCents !== charge.amount_cents
  ) {
    fail("the disputed invoice does not owe exactly the detention");
  }
}

// Cash Friday (design 4.9): one bank position, six bills with two flexible ones due by pay day, no
// checks, and the planted gap to the cent at any anchor (the balance is set from the engine). Both
// demo carriers are covered, so neither gets options (golden.json cashFriday pins them at none).
function cashFriday(plan: CarrierPlan): void {
  const { rows, carrier, anchor } = plan;
  if (rows.cash_settings.length !== 1) fail("a carrier needs one cash settings row");
  if (rows.cash_checks.length !== 0) fail("the seed writes no cash checks");
  if (rows.factoring_requests.length !== 0 || rows.factoring_request_invoices.length !== 0) {
    fail("the seed factors no invoices");
  }
  if (rows.vendor_bills.length !== 6) fail("a carrier needs six vendor bills");
  const r = cashPositionOf(rows, carrier, anchor, flags.cashFridayLimits);
  if (r.figures.gapCents !== plantedGapCents(carrier.slug)) fail("the cash gap is not the planted one");
  const flexible = rows.vendor_bills.filter(
    (b) => b.status === "open" && b.urgency === "flexible" && b.due_on <= r.payDay,
  );
  if (flexible.length !== 2) fail("two flexible bills must be due by pay day");
  if (r.figures.gapCents >= 0 && r.options.length !== 0) fail("a covered carrier has cash options");
}

// The invoice review plants: each planted invoice reads back as its planted status through the
// same engine and inputs the pages use, every other invoice is out of the review queue, exactly
// the two planted customers require a delivery document, and every customer has a billing
// address on the reserved example domain. The seed writes no ledger rows, documents or invoice
// cards, so every seeded invoice is history: the ready plant is recorded as sent by hand, no post.
function invoiceReviewPlants(plan: CarrierPlan): void {
  const { rows, planted } = plan;
  const r = planted.invoiceReview;
  const facts = reviewFactsOf({
    invoices: rows.invoices,
    customers: rows.customers,
    loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
    documents: [],
    postings: new Map(),
    queueCardLoads: new Set(),
  });
  const want = new Map<string, string>([
    [r.missingDocumentsInvoiceId, "missing_documents"],
    [r.duplicateInvoiceIds[0], "duplicate_warning"],
    [r.duplicateInvoiceIds[1], "duplicate_warning"],
    [r.rateMismatchInvoiceId, "rate_mismatch"],
    [r.readyInvoiceId, "ready_to_send"],
    ...r.needsReviewInvoiceIds.map((id): [string, string] => [id, "needs_review"]),
  ]);
  if (want.size !== 5 + r.needsReviewInvoiceIds.length) fail("two review plants share an invoice");
  for (const inv of rows.invoices) {
    const review = reviewInvoice(reviewInputOf(inv, facts));
    const queued = inReviewQueue(inv.status, review);
    const planted = want.get(inv.id);
    if (planted === undefined) {
      if (queued) fail(`invoice ${inv.invoice_number} is in the review queue without a plant`);
      continue;
    }
    if (!queued || review.status !== planted) {
      fail(`review plant ${inv.invoice_number} reads ${review.status}, not ${planted}`);
    }
    if (inv.sent_on !== null) fail("a review plant is recorded as sent");
  }
  const ready = rows.invoices.find((i) => i.id === r.readyInvoiceId)!;
  const readyReview = reviewInvoice(reviewInputOf(ready, facts));
  if (readyReview.reasons.length !== 0) fail("the ready plant has more to clear than recording the send");
  const dup = reviewInvoice(reviewInputOf(rows.invoices.find((i) => i.id === r.duplicateInvoiceIds[1])!, facts));
  if (dup.reasons.join() !== "same_amount_recent,not_reviewed" || dup.duplicateOf.join() !== r.duplicateInvoiceIds[0]) {
    fail("the duplicate plant shows more than the duplicate");
  }
  const pod = rows.customers.filter((c) => c.pod_required).map((c) => c.id).sort();
  if (pod.join() !== [...r.podCustomerIds].sort().join()) fail("the document rule is not exactly the two plants");
  for (const c of rows.customers) {
    if (c.billing_email === null || !/^[a-z0-9._-]+@[a-z0-9-]+\.example$/.test(c.billing_email)) {
      fail(`customer ${c.code} has no example billing address`);
    }
  }
}

// The card provider's statement: the card check finds exactly the four planted differences, the
// unknown card is on no driver's file, and its candidates put one driver on top (or, where every
// state is shared, a tie a person resolves). The seed writes no check and no difference.
function cardStatementPlants(plan: CarrierPlan): void {
  const { rows, anchor, carrier } = plan;
  const p = plan.planted.cardRecon;
  const heroId = carrier.heroCode ? rows.drivers.find((d) => d.code === carrier.heroCode)?.id : undefined;
  if (rows.card_recon_runs.length !== 0 || rows.card_recon_breaks.length !== 0) {
    fail("the seed writes no card check and no difference");
  }
  unique(rows.card_transactions, (t) => t.provider_ref, "statement reference");
  unique(rows.card_transactions, (t) => t.id, "statement id");
  for (const t of rows.card_transactions) {
    if ((t.kind === "fuel") !== (t.state !== null && t.gallons_milli !== null)) fail("a statement row is half fuel");
    if (t.kind === "load" && !/^fcs_load_[0-9a-f]{24}$/.test(t.provider_ref)) fail("a card load has a bad reference");
    if (!/^[A-Z0-9 -]{2,40}$/.test(t.portal_name)) fail("a statement row has a bad portal name");
  }
  const window = { start: addDays(anchor, -STATEMENT_DAYS), end: addDays(anchor, -1) };
  const found = reconcileStatement({
    txns: rows.card_transactions.map((t) => ({
      id: t.id,
      providerRef: t.provider_ref,
      kind: t.kind,
      cardToken: t.card_token,
      cardLast4: t.card_last4,
      portalName: t.portal_name,
      postedOn: t.posted_on,
      amountCents: t.amount_cents,
      state: t.state,
      gallonsMilli: t.gallons_milli,
    })),
    purchases: rows.fuel_purchases.map((f) => ({
      id: f.id,
      driverId: f.driver_id,
      purchaseRef: f.purchase_ref,
      amountCents: f.amount_cents,
    })),
    cards: rows.driver_cards.map((c) => ({
      driverId: c.driver_id,
      providerToken: c.provider_token,
      portalName: c.portal_name,
      status: c.status,
    })),
    cardLoads: [],
    window,
  });
  const got = found.map((b) => `${b.category}:${b.cardTransactionId}`).sort().join();
  const want = [
    `fuel_amount_differs:${p.fuelAmountDiffersId}`,
    `purchase_not_recorded:${p.purchaseNotRecordedId}`,
    `card_unknown:${p.cardUnknownId}`,
    `load_not_in_ledger:${p.loadNotInLedgerId}`,
  ]
    .sort()
    .join();
  if (got !== want) fail("the card check finds more or less than the four statement plants");
  const amount = found.find((b) => b.category === "fuel_amount_differs")!;
  if (amount.outsideCents! - amount.ourCents! !== PLANT_FUEL_EXTRA_CENTS) fail("the amount plant is not $3.40 over");
  const txn = (id: string) => rows.card_transactions.find((t) => t.id === id)!;
  if (txn(p.loadNotInLedgerId).amount_cents !== PLANT_LOAD_CENTS) fail("the card load plant is not $150.00");
  const unknown = txn(p.cardUnknownId);
  if (unknown.amount_cents !== PLANT_UNKNOWN_CENTS) fail("the unknown card plant is not $212.40");
  if (rows.driver_cards.some((c) => c.provider_token === unknown.card_token || c.last4 === unknown.card_last4)) {
    fail("the unknown card is on file");
  }
  if (rows.fuel_purchases.some((f) => f.purchase_ref === txn(p.loadNotInLedgerId).provider_ref)) {
    fail("the card load plant matches a purchase");
  }
  for (const id of [p.fuelAmountDiffersId, p.purchaseNotRecordedId, p.cardUnknownId, p.loadNotInLedgerId]) {
    if (!isWithin(txn(id).posted_on, plan.periods[3])) fail("a statement plant is outside the open week");
  }
  const ranked = rankCandidates(
    { postedOn: unknown.posted_on, state: unknown.state, portalName: unknown.portal_name },
    {
      drivers: rows.drivers.map((d) => ({ id: d.id, code: d.code, activeFrom: d.active_from, activeTo: d.active_to })),
      days: rows.driver_days.map((d) => ({ driverId: d.driver_id, day: d.day, loadId: d.load_id })),
      loads: rows.loads.map((l) => ({ id: l.id, originState: l.origin_state, destState: l.dest_state })),
      stateMiles: rows.load_state_miles.map((m) => ({ loadId: m.load_id, state: m.state })),
      cards: rows.driver_cards.map((c) => ({
        driverId: c.driver_id,
        providerToken: c.provider_token,
        portalName: c.portal_name,
        status: c.status,
      })),
    },
  );
  if (ranked.length === 0 || ranked[0].score < 3) fail("the unknown card has no driver on a load in its state");
  if (p.candidateDriverId === null) {
    if (!topIsTied(ranked)) fail("the unknown card's tie plant has a clear top");
  } else {
    if (topIsTied(ranked) || ranked[0].driverId !== p.candidateDriverId) fail("the unknown card's top is not the plant");
    if (p.candidateDriverId === heroId) fail("the unknown card's driver is the hero");
  }
}
