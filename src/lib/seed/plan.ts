import { configFor, configForDay } from "../data/config-version";
import { loadsOf, payConfigOf } from "../data/records";
import type {
  AdvanceRow,
  CustomerRow,
  DeductionScheduleRow,
  DriverCardRow,
  DriverDayRow,
  DriverRow,
  FuelPurchaseRow,
  LoadAccessorialRow,
  LoadRow,
  LoadStateMilesRow,
  PayItemRow,
  SettlementPeriodRow,
  TenantRows,
} from "../data/rows";
import { compareText, roundHalfUp } from "../rules-engine";
import {
  addDays,
  datesBetween,
  dayOfWeek,
  daysBetween,
  isLocalDate,
  isWithin,
  localDateOf,
  periodContaining,
  type LocalDate,
  type Period,
} from "../time/local-date";
import { buildReceivables, type CollectionsPlant, type WrongInvoicePlant } from "./ar-plan";
import { assertPlan, seededAdvanceDecision } from "./assert-plan";
import { instantAt } from "./calendar";
import { detentionTermsOf, type DemoCarrier } from "./carriers";
import { applyHistory } from "./history";
import { HERO_LANES, LANES, laneMiles, reverseLane, type Lane } from "./lanes";
import { CUSTOMERS, FIRST_NAMES, LAST_NAMES } from "./names";
import { Rng } from "./prng";
import {
  armedAt,
  armEvents,
  chooseDisarmed,
  chooseTakeBack,
  driverIdentities,
  linkAdvanceLoads,
  parityCards,
  plantLoadPair,
  plantTakeBack,
  type AdvanceDraft,
  type ParityPlanted,
} from "./parity-plan";
import { planInvoiceReview, type ReviewPlant } from "./review-plan";
import { buildUntrustedInputs } from "./untrusted-inputs";

// buildCarrierPlan(carrier, anchor): every row the seed writes for one demo carrier, built in
// memory from nothing but the carrier constants and the anchor date (never the clock), so the
// same anchor always gives the same rows and the same ids. The four pay periods are the four
// weeks of the carrier's week shape that end on or before anchor - 1: three settled by the engine
// (history.ts), the last one open. The plan is checked whole (assert-plan.ts) before anything
// can be written. The cases added later (addendum B: fuel anomalies, detention, stop times, fuel
// tanks) draw from a second stream, side, so the rows the first stream makes stay as they were.

type Role = "company_mile" | "company_flat" | "oo_leased" | "oo_owned";

const ROLE_MIX: readonly (readonly [Role, number])[] = [
  ["company_mile", 11],
  ["company_flat", 2],
  ["oo_leased", 6],
  ["oo_owned", 6],
];

// The drivers (codes) who carry the planted problems: the six pay problems, then the four fuel
// anomalies. Never the hero, all distinct.
export type Victims = {
  duplicateAdvance: string;
  fuelItemDriver: string;
  fuelLoadDriver: string;
  dayNotDriven: string;
  missingReimbursement: string;
  noRate: string;
  overLimit: string;
  fuelOffRoute: string;
  fuelOverTank: string;
  fuelParked: string;
  fuelDuplicate: string;
};

type FuelVictim = "fuelOffRoute" | "fuelOverTank" | "fuelParked" | "fuelDuplicate";

// The ids of the planted rows, for the tests and for the checks that must find them.
export type Planted = {
  duplicateAdvanceIds: [string, string];
  wrongDriverFuelItemId: string;
  wrongDriverPurchaseId: string;
  dispatchDayId: string;
  unreimbursedLumperId: string;
  noRateLoadId: string;
  overLimitAdvanceIds: [string, string];
  wrongInvoice: WrongInvoicePlant;
  fuelOffRouteId: string;
  fuelOverTankId: string;
  fuelParkedId: string;
  // The same receipt turned in twice: [older, newer] fill-ups and their two paybacks.
  fuelDuplicateIds: [string, string];
  fuelDuplicatePaybackIds: [string, string];
  // The four loads with unbilled detention, in plant order A to D.
  detentionLoadIds: string[];
  collections: CollectionsPlant[];
  invoiceReview: ReviewPlant;
  // Arming, the extra cards, the load pair and the take-back (parity-plan.ts).
  parity: ParityPlanted;
};

export type CarrierPlan = {
  carrier: DemoCarrier;
  anchor: LocalDate;
  periods: Period[];
  victims: Victims;
  planted: Planted;
  rows: TenantRows;
};

// The four weeks ending on or before anchor - 1, oldest first.
export function planPeriods(anchor: LocalDate, weekStartDow: number): Period[] {
  const lastDay = addDays(anchor, -1);
  let last = periodContaining(lastDay, weekStartDow);
  if (last.end > lastDay) last = periodContaining(addDays(last.start, -1), weekStartDow);
  return [3, 2, 1, 0].map((back) => ({
    start: addDays(last.start, -7 * back),
    end: addDays(last.end, -7 * back),
  }));
}

function weekday(period: Period, dow: number): LocalDate {
  const day = datesBetween(period.start, period.end).find((d) => dayOfWeek(d) === dow);
  if (!day) throw new Error("week has no such weekday");
  return day;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// Days a regional load takes, from pickup to delivery.
function spanDays(loadedMiles: number): number {
  if (loadedMiles <= 300) return 1;
  if (loadedMiles <= 600) return 2;
  return 3;
}

type LoadDraft = { row: LoadRow; lane: Lane; week: number; driverCode: string; order: number };

// A state no lane of the carrier crosses, for the purchase made off route.
const OFF_ROUTE_STATE: Record<DemoCarrier["prefix"], string> = { BR: "FL", PW: "NM" };

// The four unbilled detention cases (addendum B3): the customer (by list index), the stop, and
// the minutes at it. Past 120 free minutes they bill 41,250 + 30,000 + 37,500 + 26,250 cents.
const DETENTION_PLANTS: readonly [number, "pickup" | "delivery", number][] = [
  [3, "delivery", 440],
  [0, "delivery", 480],
  [7, "pickup", 420],
  [4, "delivery", 435],
];
const MINUTE_MS = 60_000;
const minutesBefore = (at: string, minutes: number) =>
  new Date(Date.parse(at) - minutes * MINUTE_MS).toISOString();

// One active fuel card per driver, from its own id stream (`<seed>:cards`) so no other row's id or
// number moves. Last four digits are drawn until unique within the carrier. Every card answers
// "ok" except two planted ones on the two highest driver codes that are not the hero: the higher
// is declined, the next is slow. Never "offline" in the seed.
export function buildDriverCards(seed: string, drivers: readonly DriverRow[], heroCode: string | null): DriverCardRow[] {
  const cards = new Rng(`${seed}:cards`);
  const planted = drivers
    .map((d) => d.code)
    .filter((code) => code !== heroCode)
    .sort((a, b) => compareText(b, a));
  const behaviorOf = (code: string): DriverCardRow["sim_behavior"] =>
    code === planted[0] ? "declined" : code === planted[1] ? "slow" : "ok";
  const usedLast4 = new Set<string>();
  return drivers.map((d) => {
    const id = cards.uuid();
    const token = `fcs_card_${cards.uuid().replace(/-/g, "").slice(0, 24)}`;
    let last4 = "";
    do {
      last4 = String(cards.int(0, 9999)).padStart(4, "0");
    } while (usedLast4.has(last4));
    usedLast4.add(last4);
    return {
      id,
      driver_id: d.id,
      rail: "fuel_card",
      provider: "fuel_card_sim",
      provider_token: token,
      last4,
      status: "active",
      sim_behavior: behaviorOf(d.code),
      source: "seed",
      closed_at: null,
      // Each driver's one card is their default (0027); parity-plan.ts adds the extra cards.
      is_default: true,
      holder_kind: "named",
      portal_name: null,
    };
  });
}

export function buildCarrierPlan(carrier: DemoCarrier, anchor: LocalDate): CarrierPlan {
  if (!isLocalDate(anchor)) throw new Error("anchor is not a YYYY-MM-DD date");
  const zone = carrier.timezone;
  const seed = `${carrier.slug}:${anchor}`;
  const rng = new Rng(`${seed}:plan`);
  const side = new Rng(`${seed}:side`);
  const ids = new Rng(`${seed}:ids`);
  // The advance parity rows (0027) draw only from here, so no other row moves.
  const parity = new Rng(`${seed}:parity`);
  const newId = () => ids.uuid();
  const { prefix, slug } = carrier;
  const lanes = LANES[prefix];
  const periods = planPeriods(anchor, carrier.payConfigs[0].week_start_dow);
  const openWeek = periods[3];
  // The pay rules versions, dated by the week each starts; ids are made with the other rows.
  const versions = carrier.payConfigs.map(({ from_week, note, ...knobs }) => {
    const week = periods[from_week];
    if (!week) throw new Error("a pay rules version starts outside the four weeks");
    return { ...knobs, effective_from: week.start, note };
  });
  // The open week's version: escrow terms and schedules come from it.
  const config = configFor(versions, openWeek.start);

  // ---- Customers ----
  const customers: CustomerRow[] = CUSTOMERS[prefix].map((c, i) => ({
    id: newId(),
    code: `${prefix}-C${pad2(i + 1)}`,
    name: c.name,
    terms_days: rng.weighted([
      [15, 2],
      [30, 6],
      [45, 2],
    ]),
    city: c.city,
    state: c.state,
    detention_free_minutes: detentionTermsOf(i).freeMinutes,
    detention_hourly_cents: detentionTermsOf(i).hourlyCents,
    // The review plan turns the document rule on for two customers.
    pod_required: false,
    billing_email: `ar@${prefix.toLowerCase()}-c${pad2(i + 1)}.example`,
  }));

  // ---- Drivers ----
  const roles = rng.shuffle(ROLE_MIX.flatMap(([role, n]) => Array<Role>(n).fill(role)));
  const heroIndex = carrier.heroCode ? Number(carrier.heroCode.slice(-2)) - 1 : -1;
  if (heroIndex >= 0 && roles[heroIndex] !== "oo_owned") {
    const j = roles.indexOf("oo_owned");
    [roles[heroIndex], roles[j]] = [roles[j], roles[heroIndex]];
  }
  const firsts = rng.shuffle(FIRST_NAMES);
  const lasts = rng.shuffle(LAST_NAMES);
  const roleOf = new Map<string, Role>();
  const drivers: DriverRow[] = roles.map((role, i) => {
    const code = `${prefix}-D${pad2(i + 1)}`;
    roleOf.set(code, role);
    const isOo = role === "oo_leased" || role === "oo_owned";
    const isHero = code === carrier.heroCode;
    const step = config.escrow_per_settlement_cents;
    let escrow = 0;
    if (isHero) escrow = 100000;
    else if (isOo) {
      escrow = rng.chance(1, 4)
        ? config.escrow_target_cents
        : rng.int(0, config.escrow_target_cents / step - 1) * step;
    }
    return {
      id: newId(),
      code,
      first_name: firsts[i],
      last_name: lasts[i],
      email: `${code.toLowerCase()}@${carrier.emailDomain}`,
      worker_type: isOo ? "owner_operator" : "company",
      pay_basis: role === "company_mile" ? "per_mile" : role === "company_flat" ? "flat" : "percent",
      per_mile_cents: role === "company_mile" ? rng.int(58, 66) : null,
      percent_bps: isOo ? (isHero ? 7500 : rng.int(72, 78) * 100) : null,
      flat_per_load_cents: role === "company_flat" ? rng.int(36, 44) * 500 : null,
      advance_limit_cents: null,
      escrow_balance_cents: escrow,
      truck_unit: `${prefix}-T${101 + i}`,
      // Local trucks hold 150 gallons, the rest 200 to 300, so every ordinary fill fits.
      tank_gallons: role === "company_flat" ? 150 : side.int(20, 30) * 10,
      active_from: addDays(anchor, -rng.int(120, 1500)),
      active_to: null,
      // Every fourth driver by position reads Spanish, so each carrier has Spanish pay notes.
      // Decided by index, not the random stream, so no other seeded value moves.
      preferred_language: i % 4 === 3 ? "es" : "en",
      // Armed from the day they started (set just below); one planted driver is disarmed later.
      money_armed: true,
      money_armed_at: null,
      own_insurance: false,
    };
  });
  for (const d of drivers) d.money_armed_at = armedAt(d.active_from, zone);
  const byCode = new Map(drivers.map((d) => [d.code, d]));
  const driver = (code: string) => {
    const d = byCode.get(code);
    if (!d) throw new Error("unknown driver code");
    return d;
  };
  const codeOf = new Map(drivers.map((d) => [d.id, d.code]));

  // ---- Victims: chosen by role, distinct, never the hero ----
  const taken = new Set<string>(carrier.heroCode ? [carrier.heroCode] : []);
  const choose = (allowed: Role[]) => {
    const pool = drivers.filter((d) => allowed.includes(roleOf.get(d.code)!) && !taken.has(d.code));
    const code = rng.pick(pool).code;
    taken.add(code);
    return code;
  };
  const victims: Omit<Victims, FuelVictim> = {
    fuelItemDriver: choose(["oo_leased"]),
    fuelLoadDriver: choose(["company_mile"]),
    // Insurance applies to owner-operators at both carriers.
    dayNotDriven: choose(["oo_leased", "oo_owned"]),
    noRate: choose(["company_mile"]),
    overLimit: choose(["company_mile"]),
    duplicateAdvance: choose(["company_mile", "oo_leased", "oo_owned"]),
    missingReimbursement: choose(["company_mile", "oo_leased", "oo_owned"]),
  };
  driver(victims.duplicateAdvance).advance_limit_cents = 100000;
  driver(victims.overLimit).advance_limit_cents = 50000;
  const victimCodes = new Set(Object.values(victims));

  // ---- Loads ----
  const drafts: LoadDraft[] = [];
  const addLoad = (
    d: DriverRow,
    week: number,
    lane: Lane,
    pickup: LocalDate,
    delivered: LocalDate | null,
    regional: boolean,
    money?: { linehaul: number; fsc: number },
  ): LoadDraft => {
    const loaded = laneMiles(lane);
    const empty = regional ? rng.int(30, 180) : rng.int(5, 25);
    let linehaul = rng.int(35, 65) * 1000;
    let fsc = rng.int(30, 80) * 100;
    if (money) ({ linehaul, fsc } = money);
    else if (regional) {
      linehaul = roundHalfUp(loaded * rng.int(210, 320), 100) * 100;
      fsc = roundHalfUp(loaded * rng.int(40, 60), 100) * 100;
    }
    let deliveredAt: string | null = null;
    if (delivered) {
      deliveredAt = instantAt(delivered, rng.int(6, 19), rng.int(0, 59), zone);
      if (localDateOf(deliveredAt, zone) !== delivered) throw new Error("delivery left its day");
    }
    const draft: LoadDraft = {
      row: {
        id: newId(),
        load_number: "",
        customer_id: rng.pick(customers).id,
        driver_id: d.id,
        status: !delivered ? "in_transit" : week < 3 ? "invoiced" : "delivered",
        origin_city: lane.from.city,
        origin_state: lane.from.state,
        dest_city: lane.to.city,
        dest_state: lane.to.state,
        pickup_on: pickup,
        delivered_on: delivered,
        delivered_at: deliveredAt,
        loaded_miles: loaded,
        empty_miles: empty,
        linehaul_cents: linehaul,
        fuel_surcharge_cents: fsc,
        // Set from the bill of lading once the load is delivered (stop times, below).
        pickup_arrived_at: null,
        pickup_departed_at: null,
        delivery_arrived_at: null,
        delivery_departed_at: null,
      },
      lane,
      week,
      driverCode: d.code,
      order: drafts.length,
    };
    drafts.push(draft);
    return draft;
  };
  const either = (l: Lane) => (rng.chance(1, 2) ? l : reverseLane(l));
  const shortest = lanes.regional.reduce((a, b) => (laneMiles(b) < laneMiles(a) ? b : a));
  // Loads that never get random extras (accessorials, tolls, scale tickets).
  const plain = new Set<string>();
  const heroLoads: LoadDraft[] = [];

  for (const d of drivers) {
    const role = roleOf.get(d.code)!;
    const isHero = d.code === carrier.heroCode;
    periods.forEach((p, week) => {
      const open = week === 3;
      if (role === "company_flat") {
        // Local work: one load each weekday and up to two more.
        const weekdays = datesBetween(p.start, p.end).filter((x) => dayOfWeek(x) % 6 !== 0);
        const extra = Array.from({ length: rng.int(0, 2) }, () => rng.pick(weekdays));
        for (const day of [...weekdays, ...extra].sort()) {
          addLoad(d, week, either(rng.pick(lanes.local)), day, day, false);
        }
        return;
      }
      if (isHero && open) {
        // The worked example: three fixed loads, Monday to Friday.
        if (dayOfWeek(p.start) !== 1) throw new Error("the hero's week must start on Monday");
        const r = lanes.regional;
        const fixed: [Lane, number, number, number][] = [
          [r[HERO_LANES.raleighPhiladelphia], 0, 110000, 14000],
          [reverseLane(r[HERO_LANES.fayettevilleTrenton]), 1, 130000, 16500],
          [r[HERO_LANES.wilmingtonSavannah], 3, 80000, 9500],
        ];
        for (const [lane, start, linehaul, fsc] of fixed) {
          const pickup = addDays(p.start, start);
          const draft = addLoad(d, week, lane, pickup, addDays(pickup, 1), true, { linehaul, fsc });
          plain.add(draft.row.id);
          heroLoads.push(draft);
        }
        return;
      }
      if (d.code === victims.overLimit && week === 2) {
        // One short day: pay stays under the net pay floor, so the week's advance stays owed.
        const day = addDays(p.start, rng.int(0, 4));
        plain.add(addLoad(d, week, either(shortest), day, day, true).row.id);
        return;
      }
      const lastDay =
        open && d.code === victims.dayNotDriven ? addDays(weekday(p, 6), -1) : p.end;
      const count = isHero ? 3 : rng.int(2, 4);
      let day = addDays(p.start, rng.int(0, 1));
      let prev: Lane | null = null;
      for (let k = 0; k < count && day <= lastDay; k++) {
        let lane: Lane =
          prev && rng.chance(1, 2) ? reverseLane(prev) : either(rng.pick(lanes.regional));
        // The hero's settled weeks: three mid-length loads that always fit the week.
        while (isHero && (laneMiles(lane) < 240 || laneMiles(lane) > 420)) {
          lane = either(rng.pick(lanes.regional));
        }
        const delivered = addDays(day, spanDays(laneMiles(lane)) - 1);
        if (delivered > lastDay) {
          // Only the open week may end with a load still on the road.
          if (open && d.code !== victims.dayNotDriven) addLoad(d, week, lane, day, null, true);
          break;
        }
        const draft = addLoad(d, week, lane, day, delivered, true);
        if (isHero) plain.add(draft.row.id);
        prev = lane;
        day = addDays(delivered, rng.int(0, 1));
      }
    });
  }

  drafts.sort((a, b) => compareText(a.row.pickup_on, b.row.pickup_on) || a.order - b.order);
  drafts.forEach((x, i) => {
    x.row.load_number = `${prefix}-L${10001 + i}`;
    x.order = i;
  });
  const loads = drafts.map((x) => x.row);
  const firstDelivered = (code: string, week: number) => {
    const found = drafts.find(
      (x) => x.driverCode === code && x.week === week && x.row.delivered_on !== null,
    );
    if (!found) throw new Error("a victim has no delivered load that week");
    return found;
  };

  // Planted: a delivered load with no rate (victim 6, paid by the mile, so pay still computes).
  const noRateLoad = firstDelivered(victims.noRate, 3);
  noRateLoad.row.linehaul_cents = null;

  // Miles per state: the lane's split, with the empty miles on the first state (the deadhead).
  const stateMiles: LoadStateMilesRow[] = drafts.flatMap((x) =>
    x.lane.states.map(([state, miles], i) => ({
      id: newId(),
      load_id: x.row.id,
      state,
      miles: i === 0 ? miles + x.row.empty_miles : miles,
    })),
  );

  // ---- Accessorials ----
  const accessorials: LoadAccessorialRow[] = [];
  const missingLoad = firstDelivered(victims.missingReimbursement, 3);
  plain.add(missingLoad.row.id);
  for (const x of drafts) {
    if (!x.row.delivered_on || plain.has(x.row.id)) continue;
    const add = (
      kind: LoadAccessorialRow["kind"],
      amount: number,
      paidByDriver: boolean,
      description: string,
    ) =>
      accessorials.push({
        id: newId(),
        load_id: x.row.id,
        kind,
        seq: 1,
        amount_cents: amount,
        paid_by_driver: paidByDriver,
        description,
      });
    if (rng.chance(1, 8)) {
      const byDriver = rng.chance(1, 2);
      const label = byDriver ? "Lumper, paid by driver" : "Lumper";
      add("lumper", rng.int(15, 50) * 500, byDriver, label);
    }
    if (rng.chance(1, 10)) add("detention", rng.int(10, 40) * 500, false, "Detention at shipper");
    if (rng.chance(1, 12)) add("stop", rng.int(15, 30) * 500, false, "Extra stop");
    if (rng.chance(1, 40)) add("layover", rng.int(30, 60) * 500, false, "Layover");
  }
  // Planted: a lumper the driver paid, with no reimbursement (victim 5).
  const plantedLumper: LoadAccessorialRow = {
    id: newId(),
    load_id: missingLoad.row.id,
    kind: "lumper",
    seq: 1,
    amount_cents: 17500,
    paid_by_driver: true,
    description: "Lumper, paid by driver",
  };
  accessorials.push(plantedLumper);

  // ---- Driver days: every day a load spans (an in-transit load up to the week's end) ----
  const days: DriverDayRow[] = [];
  const dayKeys = new Set<string>();
  const daysOf = (x: LoadDraft) =>
    datesBetween(x.row.pickup_on, x.row.delivered_on ?? periods[x.week].end);
  for (const x of drafts) {
    for (const day of daysOf(x)) {
      const key = `${x.row.driver_id}:${day}`;
      if (dayKeys.has(key)) continue;
      dayKeys.add(key);
      days.push({ id: newId(), driver_id: x.row.driver_id!, day, source: "load", load_id: x.row.id });
    }
  }
  // Planted: a dispatch day on Saturday of the open week that no load spans (victim 4).
  const saturday = weekday(openWeek, 6);
  const dispatchDay: DriverDayRow = {
    id: newId(),
    driver_id: driver(victims.dayNotDriven).id,
    day: saturday,
    source: "dispatch",
    load_id: null,
  };
  if (dayKeys.has(`${dispatchDay.driver_id}:${saturday}`)) {
    throw new Error("the planted dispatch day is a driven day");
  }
  days.push(dispatchDay);

  // ---- Fuel purchases: one per regional load, two past 450 miles; three local loads in ten ----
  type FuelDraft = { row: FuelPurchaseRow; order: number };
  const fuel: FuelDraft[] = [];
  const addFuel = (
    d: DriverRow,
    loadId: string | null,
    day: LocalDate,
    [hour, minute]: [number, number],
    state: string,
    gallonsMilli: number,
    priceCents: number,
  ) => {
    const at = instantAt(day, hour, minute, zone);
    const row: FuelPurchaseRow = {
      id: newId(),
      driver_id: d.id,
      load_id: loadId,
      purchased_at: at,
      purchased_on: localDateOf(at, zone),
      state,
      gallons_milli: gallonsMilli,
      amount_cents: roundHalfUp(gallonsMilli * priceCents, 1000),
      paid_with: roleOf.get(d.code) === "oo_owned" ? "driver_own" : "company_card",
      purchase_ref: "",
    };
    fuel.push({ row, order: fuel.length });
    return row;
  };
  for (const x of drafts) {
    const miles = x.row.loaded_miles + x.row.empty_miles;
    const local = roleOf.get(x.driverCode) === "company_flat";
    const n = local ? (rng.chance(3, 10) ? 1 : 0) : miles > 450 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const day = rng.pick(daysOf(x));
      const time: [number, number] = [rng.int(5, 21), rng.int(0, 59)];
      const state = rng.pick(x.lane.states)[0];
      addFuel(driver(x.driverCode), x.row.id, day, time, state, rng.int(60000, 140000),
        rng.int(340, 420));
    }
  }
  // Planted: a company-card purchase by victim 3 on victim 3's load, deducted below from
  // victim 2.
  const v3Load = drafts.find((x) => x.driverCode === victims.fuelLoadDriver && x.week === 3);
  if (!v3Load) throw new Error("victim 3 has no load in the open week");
  const v3State = v3Load.lane.states[0][0];
  const wrongPurchase = addFuel(driver(v3Load.driverCode), v3Load.row.id, v3Load.row.pickup_on,
    [14, 20], v3State, 71600, 400);

  // Planted (addendum B2): three fuel anomalies, each on a driver with no other problem, chosen
  // on the side stream from the drivers whose week allows the case.
  const chooseFor = (role: Role, fits: (d: DriverRow) => boolean) => {
    const pool = drivers.filter(
      (d) => roleOf.get(d.code) === role && !taken.has(d.code) && fits(d),
    );
    if (pool.length === 0) throw new Error("no driver fits a planted fuel case");
    const d = side.pick(pool);
    taken.add(d.code);
    return d;
  };
  const openLoads = (d: DriverRow) => drafts.filter((x) => x.driverCode === d.code && x.week === 3);
  const lastOf = (x: LoadDraft) => x.row.delivered_on ?? openWeek.end;
  // Off route: day 2 of an open-week load, in a state the carrier never drives.
  const twoDays = (d: DriverRow) =>
    openLoads(d).filter((x) => addDays(x.row.pickup_on, 1) <= lastOf(x));
  const v8 = chooseFor("company_mile", (d) => twoDays(d).length > 0);
  const offRouteLoad = side.pick(twoDays(v8));
  const offRouteState = OFF_ROUTE_STATE[prefix];
  const onALane = (st: string) =>
    [...lanes.regional, ...lanes.local].some((l) => l.states.some(([x]) => x === st));
  if (onALane(offRouteState)) {
    throw new Error("the off-route state is on a lane");
  }
  const offRoute = addFuel(v8, offRouteLoad.row.id, addDays(offRouteLoad.row.pickup_on, 1),
    [side.int(6, 20), side.int(0, 59)], offRouteState, 95000, 385);
  // Over the tank: more than a 200-gallon tank holds, on an open-week load, on the company card,
  // so the fill also becomes a fuel deduction below.
  const v9 = chooseFor("oo_leased", (d) => openLoads(d).length > 0);
  v9.tank_gallons = 200;
  const overTankLoad = side.pick(openLoads(v9));
  const overTank = addFuel(v9, overTankLoad.row.id, side.pick(daysOf(overTankLoad)),
    [side.int(6, 20), side.int(0, 59)], side.pick(overTankLoad.lane.states)[0], 286400, 390);
  // While parked: 22:40 on an open-week day no load of the driver spans (an in-transit load spans
  // every day from its pickup) and no day row holds, with no load named.
  const spans = (d: DriverRow, day: LocalDate) =>
    drafts.some(
      (x) =>
        x.driverCode === d.code && x.row.pickup_on <= day && day <= (x.row.delivered_on ?? day),
    );
  const parkedDays = (d: DriverRow) =>
    datesBetween(openWeek.start, openWeek.end).filter(
      (day) => !spans(d, day) && !days.some((r) => r.driver_id === d.id && r.day === day),
    );
  const v10 = chooseFor("company_mile", (d) => parkedDays(d).length > 0);
  const parkedOn = side.pick(parkedDays(v10));
  // Parked where the driver's last delivery before that day ended.
  const before = drafts.filter(
    (x) =>
      x.driverCode === v10.code && x.row.delivered_on !== null && x.row.delivered_on < parkedOn,
  );
  const parkedState =
    before.length > 0 ? before[before.length - 1].row.dest_state : lanes.regional[0].from.state;
  const parked = addFuel(v10, null, parkedOn, [22, 40], parkedState, 118000, 372);
  const fuelVictims: Pick<Victims, Exclude<FuelVictim, "fuelDuplicate">> = {
    fuelOffRoute: v8.code,
    fuelOverTank: v9.code,
    fuelParked: v10.code,
  };
  fuel.sort((a, b) => compareText(a.row.purchased_at, b.row.purchased_at) || a.order - b.order);
  fuel.forEach((f, i) => (f.row.purchase_ref = `${slug}-fuel-${i + 1}`));
  const fuelPurchases = fuel.map((f) => f.row);

  // ---- Pay items ----
  type ItemDraft = Omit<PayItemRow, "item_ref">;
  const items: ItemDraft[] = [];
  const item = (
    driverId: string,
    kind: PayItemRow["kind"],
    subkind: string,
    amount: number,
    date: LocalDate,
    ref: [NonNullable<PayItemRow["ref_table"]>, string] | null,
    description: string,
  ) => {
    const row: ItemDraft = {
      id: newId(),
      driver_id: driverId,
      kind,
      subkind,
      amount_cents: amount,
      item_date: date,
      ref_table: ref ? ref[0] : null,
      ref_id: ref ? ref[1] : null,
      description,
      settlement_id: null,
    };
    items.push(row);
    return row;
  };
  const draftOf = new Map(drafts.map((x) => [x.row.id, x]));
  for (const a of accessorials) {
    if (a.kind !== "lumper" || !a.paid_by_driver || a.id === plantedLumper.id) continue;
    const load = draftOf.get(a.load_id)!.row;
    const ref: ["load_accessorials", string] = ["load_accessorials", a.id];
    const description = "Lumper paid by driver";
    item(load.driver_id!, "reimbursement", "lumper", a.amount_cents, load.delivered_on!, ref,
      description);
  }
  for (const x of drafts) {
    if (plain.has(x.row.id)) continue;
    const [id, on] = [x.row.driver_id!, x.row.pickup_on];
    const ref: ["loads", string] = ["loads", x.row.id];
    if (rng.chance(1, 5)) item(id, "reimbursement", "toll", rng.int(12, 60) * 100, on, ref, "Tolls");
    if (rng.chance(1, 15)) {
      item(id, "reimbursement", "scale", rng.int(11, 14) * 100, on, ref, "Scale ticket");
    }
  }
  const fuelItem = (driverId: string, f: FuelPurchaseRow) =>
    item(driverId, "fuel", "fuel", f.amount_cents, f.purchased_on, ["fuel_purchases", f.id],
      "Fuel, company card");
  for (const f of fuelPurchases) {
    const leased = roleOf.get(codeOf.get(f.driver_id)!) === "oo_leased";
    if (leased && f.id !== wrongPurchase.id) fuelItem(f.driver_id, f);
  }
  // Planted: victim 3's purchase deducted from victim 2 (fuel on the wrong driver).
  const wrongFuelItem = fuelItem(driver(victims.fuelItemDriver).id, wrongPurchase);
  const deductible = drivers.filter(
    (d) =>
      d.worker_type === "owner_operator" && d.code !== carrier.heroCode && !victimCodes.has(d.code),
  );
  const OTHER: [string, string][] = [
    ["eld_fee", "ELD subscription"],
    ["cell_phone", "Cell phone plan"],
    ["plate_fee", "Plate and permit share"],
    ["cargo_claim", "Cargo claim share"],
  ];
  for (let k = 0; k < 6; k++) {
    const [subkind, description] = rng.pick(OTHER);
    const on = addDays(rng.pick(periods).start, rng.int(0, 6));
    const who = rng.pick(deductible).id;
    item(who, "other_deduction", subkind, rng.int(5, 30) * 500, on, null, description);
  }
  if (carrier.heroCode) {
    const hero = driver(carrier.heroCode).id;
    const [l1, l2] = heroLoads;
    item(hero, "reimbursement", "toll", 4500, l1.row.pickup_on, ["loads", l1.row.id], "Tolls");
    item(hero, "reimbursement", "toll", 3500, l2.row.pickup_on, ["loads", l2.row.id], "Tolls");
    const thursday = addDays(openWeek.start, 3);
    item(hero, "reimbursement", "fuel", 10000, thursday, null, "Fuel for an ordered empty reposition");
  }
  const payItems: PayItemRow[] = items
    .map((x, i) => [x, i] as const)
    .sort(([a, i], [b, j]) => compareText(a.item_date, b.item_date) || i - j)
    .map(([x], i) => ({ ...x, item_ref: `${slug}-item-${i + 1}` }));

  // ---- Unbilled detention (addendum B3) ----
  // Four settled-week loads that took more than a day, carry no charges or pay items of their
  // own, and belong to four drivers with no planted problem. Each moves to its plant's customer
  // and waits past the free time at one stop; no detention charge is on the load, so the money
  // is unbilled.
  const charged = new Set([
    ...accessorials.map((a) => a.load_id),
    ...payItems.filter((i) => i.ref_table === "loads").map((i) => i.ref_id),
  ]);
  const detentionLoads: LoadDraft[] = [];
  for (const x of side.shuffle(drafts)) {
    if (detentionLoads.length === DETENTION_PLANTS.length) break;
    const { row } = x;
    if (x.week !== 1 && x.week !== 2) continue;
    if (row.delivered_on === null || row.pickup_on >= row.delivered_on) continue;
    if (taken.has(x.driverCode) || charged.has(row.id)) continue;
    if (detentionLoads.some((y) => y.driverCode === x.driverCode)) continue;
    detentionLoads.push(x);
  }
  if (detentionLoads.length < DETENTION_PLANTS.length) throw new Error("too few detention loads");
  const plantDwell = new Map<string, { stop: "pickup" | "delivery"; minutes: number }>();
  detentionLoads.forEach((x, k) => {
    const [customerIndex, stop, minutes] = DETENTION_PLANTS[k];
    x.row.customer_id = customers[customerIndex].id;
    plantDwell.set(x.row.id, { stop, minutes });
  });

  // Planted (FUEL-ANOMALY): the same receipt turned in twice. Victim 11, a per-mile company
  // driver with no other problem (never the hero, never a detention driver), paid for one fill-up
  // on an open-week load and was paid back for it twice. Chosen and keyed on its own stream after
  // every other plant, so no other row, id or ref moves; the two fill-ups and the two paybacks
  // are numbered after the last ones. Third day of the open week or later, on a state the load
  // drove through, six minutes apart on one day.
  const dup = new Rng(`${seed}:dup`);
  const dupFrom = addDays(openWeek.start, 2);
  const detentionDrivers = new Set(detentionLoads.map((x) => x.driverCode));
  const dupDays = (x: LoadDraft) =>
    daysOf(x).filter((day) => day >= dupFrom && day <= openWeek.end);
  const dupFits = (d: DriverRow) =>
    roleOf.get(d.code) === "company_mile" &&
    !taken.has(d.code) &&
    openLoads(d).some((x) => dupDays(x).length > 0);
  // A driver with no plant at all first; a detention driver (a settled-week billing plant, never
  // their pay) only when no other fits.
  const clear = drivers.filter((d) => dupFits(d) && !detentionDrivers.has(d.code));
  const dupPool = clear.length > 0 ? clear : drivers.filter(dupFits);
  if (dupPool.length === 0) throw new Error("no driver fits the duplicate receipt");
  const v11 = dup.pick(dupPool);
  taken.add(v11.code);
  const dupLoad = dup.pick(openLoads(v11).filter((x) => dupDays(x).length > 0));
  const dupDay = dup.pick(dupDays(dupLoad));
  const dupState = dup.pick(stateMiles.filter((m) => m.load_id === dupLoad.row.id)).state;
  const [dupHour, dupMinute] = [dup.int(6, 20), dup.int(0, 50)];
  const dupFill = (minute: number, n: number): FuelPurchaseRow => {
    const at = instantAt(dupDay, dupHour, minute, zone);
    return {
      id: dup.uuid(),
      driver_id: v11.id,
      load_id: dupLoad.row.id,
      purchased_at: at,
      purchased_on: localDateOf(at, zone),
      state: dupState,
      gallons_milli: 84200,
      amount_cents: roundHalfUp(84200 * 380, 1000),
      paid_with: "driver_own",
      purchase_ref: `${slug}-fuel-${fuelPurchases.length + n}`,
    };
  };
  const dupOlder = dupFill(dupMinute, 1);
  const dupNewer = dupFill(dupMinute + 6, 2);
  const dupPayback = (f: FuelPurchaseRow, n: number): PayItemRow => ({
    id: dup.uuid(),
    driver_id: v11.id,
    kind: "reimbursement",
    subkind: "fuel",
    amount_cents: f.amount_cents,
    item_date: f.purchased_on,
    ref_table: "fuel_purchases",
    ref_id: f.id,
    description: "Fuel, paid by driver",
    settlement_id: null,
    item_ref: `${slug}-item-${payItems.length + n}`,
  });
  const dupPaybacks = [dupPayback(dupOlder, 1), dupPayback(dupNewer, 2)];
  fuelPurchases.push(dupOlder, dupNewer);
  payItems.push(...dupPaybacks);

  // ---- Stop times, from the bill of lading: every delivered load's arrival and departure ----
  // The truck leaves delivery when the bill is signed (delivered_at). Ordinary waits stay under
  // the smallest free time; a load billed for detention waited at pickup as long as its charge
  // says. One load waits exactly the free time, and about one open-week load in ten has no times
  // yet (not known, never zero).
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const billedDetention = new Map(
    accessorials.filter((a) => a.kind === "detention").map((a) => [a.load_id, a.amount_cents]),
  );
  const heroId = carrier.heroCode ? driver(carrier.heroCode).id : null;
  const ordinary = (x: LoadDraft) =>
    x.row.delivered_on !== null &&
    x.row.driver_id !== heroId &&
    !plantDwell.has(x.row.id) &&
    !billedDetention.has(x.row.id);
  const atFree = side.pick(
    drafts.filter((x) => ordinary(x) && x.week < 3 && x.row.pickup_on < x.row.delivered_on!),
  );
  const unknownTimes = drafts.filter((x) => ordinary(x) && x.week === 3 && side.chance(1, 10));
  if (unknownTimes.length === 0) {
    unknownTimes.push(side.pick(drafts.filter((x) => ordinary(x) && x.week === 3)));
  }
  for (const x of drafts) {
    const l = x.row;
    if (l.delivered_at === null || l.delivered_on === null || unknownTimes.includes(x)) continue;
    const customer = customerById.get(l.customer_id!)!;
    let deliveryDwell = side.int(20, 85);
    let pickupDwell = side.int(25, 85);
    const billed = billedDetention.get(l.id);
    if (billed !== undefined) {
      pickupDwell =
        customer.detention_free_minutes +
        Math.ceil((billed * 60) / customer.detention_hourly_cents);
    }
    const plant = plantDwell.get(l.id);
    if (plant?.stop === "delivery") deliveryDwell = plant.minutes;
    if (plant?.stop === "pickup") pickupDwell = plant.minutes;
    if (x === atFree) deliveryDwell = customer.detention_free_minutes;
    let deliveryArrived = minutesBefore(l.delivered_at, deliveryDwell);
    let pickupDeparted: string;
    if (l.pickup_on < l.delivered_on) {
      // Loaded during the day; a long wait at pickup moves the departure later.
      const later = Math.ceil(Math.max(0, pickupDwell - 120) / 60);
      pickupDeparted = instantAt(l.pickup_on, side.int(6, 14) + later, side.int(0, 59), zone);
    } else {
      // Same day: leave the drive time (50 miles an hour) before arriving, within the day. When
      // the pickup wait from midnight alone reaches the delivery arrival (a long billed
      // detention), the bill is signed later instead: the whole drive follows the wait, that day.
      const drive = Math.ceil((l.loaded_miles * 60) / 50);
      const earliest = Date.parse(instantAt(l.pickup_on, 0, 0, zone)) + pickupDwell * MINUTE_MS;
      if (earliest >= Date.parse(deliveryArrived)) {
        deliveryArrived = new Date(earliest + drive * MINUTE_MS).toISOString();
        l.delivered_at = new Date(
          Date.parse(deliveryArrived) + deliveryDwell * MINUTE_MS,
        ).toISOString();
        if (localDateOf(l.delivered_at, zone) !== l.delivered_on) {
          throw new Error("delivery left its day");
        }
      }
      const arrive = Date.parse(deliveryArrived);
      const ms = Math.min(arrive, Math.max(earliest, arrive - drive * MINUTE_MS));
      pickupDeparted = new Date(ms).toISOString();
    }
    l.pickup_arrived_at = minutesBefore(pickupDeparted, pickupDwell);
    l.pickup_departed_at = pickupDeparted;
    l.delivery_arrived_at = deliveryArrived;
    l.delivery_departed_at = l.delivered_at;
  }

  // ---- Advances ----
  const advanceDrafts: AdvanceDraft[] = [];
  const advance = (
    d: DriverRow,
    day: LocalDate,
    [hour, minute]: [number, number],
    amount: number,
    paidAfterMinutes: number,
    ref?: string,
  ) => {
    const at = instantAt(day, hour, minute, zone);
    const row: AdvanceDraft = {
      id: newId(),
      driver_id: d.id,
      requested_at: at,
      requested_on: localDateOf(at, zone),
      amount_cents: amount,
      fee_cents: configForDay(versions, day).advance_fee_cents,
      status: "paid",
      recovered_cents: 0,
      source: "seed",
      reason_category: null,
      paid_at: new Date(Date.parse(at) + paidAfterMinutes * 60_000).toISOString(),
      proposal_id: null,
      source_input_id: null,
      decided_at: null,
      decided_by_membership_id: null,
      load_id: null,
      taken_back_cents: 0,
      taken_back_at: null,
      taken_back_by_membership_id: null,
      takeback_reason: null,
      ref,
    };
    advanceDrafts.push(row);
    return row;
  };
  // One advance each for fourteen other drivers: ten in the settled weeks, four in the open week.
  // Each is one the engine grants when asked: requested a day or two after the driver's first
  // delivery that week, for no more than the most the engine allows on that day's earnings.
  const loadRecords = loadsOf(loads, stateMiles, accessorials);
  const most = (d: DriverRow, at: string) => {
    const version = configForDay(versions, localDateOf(at, zone));
    return seededAdvanceDecision({
      config: payConfigOf(version),
      driver: d,
      loads: loadRecords,
      periods,
      zone,
      at,
      amountCents: version.advance_min_cents,
      prior: [],
    }).maxCents;
  };
  const ownAdvances = new Set([carrier.heroCode, victims.duplicateAdvance, victims.overLimit]);
  let placed = 0;
  const placedDrafts: AdvanceDraft[] = [];
  for (const d of rng.shuffle(drivers.filter((x) => !ownAdvances.has(x.code)))) {
    if (placed === 14) break;
    const week = placed < 10 ? rng.int(0, 2) : 3;
    const p = periods[week];
    const first = loads
      .filter((l) => l.driver_id === d.id && l.delivered_on !== null && isWithin(l.delivered_on, p))
      .map((l) => l.delivered_on!)
      .sort()[0];
    if (!first || first >= p.end) continue;
    const day = addDays(first, rng.int(1, Math.min(2, daysBetween(first, p.end))));
    const time: [number, number] = [rng.int(7, 17), rng.int(0, 59)];
    const cap = most(d, instantAt(day, time[0], time[1], zone));
    const amount = Math.min(rng.int(4, 16) * 2500, Math.floor(cap / 2500) * 2500);
    if (amount < 10000) continue;
    placedDrafts.push(advance(d, day, time, amount, rng.int(20, 90)));
    placed++;
  }
  if (placed < 14) throw new Error("too few drivers earned enough for an advance");
  // Planted: the same advance logged twice, 12 minutes apart (victim 1).
  const tuesday = weekday(openWeek, 2);
  const v1 = driver(victims.duplicateAdvance);
  const dupA = advance(v1, tuesday, [9, 14], 34000, 30, `${slug}-adv-dup-a`);
  const dupB = advance(v1, tuesday, [9, 26], 34000, 30, `${slug}-adv-dup-b`);
  // Planted: two advances over a $500 limit (victim 7). The first is in a settled week whose pay
  // is under the floor, so none of it is recovered.
  const v7 = driver(victims.overLimit);
  const over1 = advance(v7, weekday(periods[2], 3), [11, 5], 35000, 25);
  const over2 = advance(v7, weekday(openWeek, 3), [8, 40], 30000, 25);
  if (carrier.heroCode) {
    advance(driver(carrier.heroCode), weekday(openWeek, 3), [10, 15], 20000, 25).fee_cents = 0;
  }
  // Parity plants (0027), from the parity stream: two advances on one load for a driver with none,
  // the load each other advance is for, and the open-week advance to take back in full (one no
  // settlement has recovered from; recorded after history, below).
  // Every planted driver, the duplicate-receipt one (victim 11) included.
  const allVictims = new Set<string>([
    ...Object.values(victims),
    ...Object.values(fuelVictims),
    v11.code,
  ]);
  const withAdvance = new Set(advanceDrafts.map((a) => a.driver_id));
  const pair = plantLoadPair({
    parity,
    slug,
    zone,
    drivers,
    skip: new Set([
      ...(carrier.heroCode ? [carrier.heroCode] : []),
      ...drivers.filter((d) => withAdvance.has(d.id)).map((d) => d.code),
    ]),
    victims: allVictims,
    loads: loadRecords,
    versions,
    periods,
    lastDay: addDays(anchor, -1),
  });
  advanceDrafts.push(...pair.rows);
  linkAdvanceLoads(advanceDrafts, drivers, loadRecords, versions);
  const takenBackId = chooseTakeBack(parity, placedDrafts, periods);
  let advanceN = 0;
  const advances: AdvanceRow[] = advanceDrafts
    .map((a, i) => [a, i] as const)
    .sort(([a, i], [b, j]) => compareText(a.requested_at, b.requested_at) || i - j)
    .map(([{ ref, ...rest }]) => ({ ...rest, request_ref: ref ?? `${slug}-adv-${++advanceN}` }));

  // ---- Schedules and periods ----
  const schedules: DeductionScheduleRow[] = [];
  for (const d of drivers) {
    if (d.worker_type !== "owner_operator") continue;
    schedules.push({
      id: newId(),
      driver_id: d.id,
      kind: "escrow",
      amount_cents: config.escrow_per_settlement_cents,
      target_cents: config.escrow_target_cents,
      description: "Escrow",
      active_from: d.active_from,
      active_to: null,
    });
    if (roleOf.get(d.code) === "oo_leased") {
      schedules.push({
        id: newId(),
        driver_id: d.id,
        kind: "lease",
        amount_cents: rng.int(85, 115) * 500,
        target_cents: null,
        description: "Truck lease-purchase payment",
        active_from: d.active_from,
        active_to: null,
      });
    }
  }
  const settlementPeriods: SettlementPeriodRow[] = periods.map((p, i) => ({
    id: newId(),
    period_start: p.start,
    period_end: p.end,
    status: i < 3 ? "paid" : "open",
  }));

  // ---- Receivables: the settled weeks' loads, the opening invoices, the payments ----
  const windowLoads = drafts.filter((x) => x.week < 3).map((x) => x.row);
  const ar = buildReceivables({
    prefix,
    anchor,
    rng: new Rng(`${seed}:receivables`),
    newId,
    customers,
    windowLoads: loadsOf(windowLoads, stateMiles, accessorials),
    openLoadIds: new Set(detentionLoads.map((x) => x.row.id)),
  });
  const invoiceReview = planInvoiceReview({
    seed,
    anchor,
    openWeek,
    customers,
    invoices: ar.invoices,
    loads,
    stateMiles,
    accessorials,
    drivers,
    heroId: carrier.heroCode ? driver(carrier.heroCode).id : null,
    takenLoadIds: new Set(detentionLoads.map((x) => x.row.id)),
    takenInvoiceIds: new Set([
      ar.wrongInvoice.appliedToInvoiceId,
      ar.wrongInvoice.meantForInvoiceId,
      ...ar.collections.map((c) => c.invoiceId),
    ]),
    applications: ar.applications,
  });

  // Parity, after every other draw on the parity stream above: the disarmed driver, the cards,
  // the dispatch-system ids and the arming log.
  const baseCards = buildDriverCards(seed, drivers, carrier.heroCode ?? null);
  const disarmed = chooseDisarmed(
    drivers,
    baseCards,
    carrier.heroCode ?? null,
    new Set(advanceDrafts.map((a) => a.driver_id)),
    allVictims,
  );
  disarmed.money_armed = false;
  disarmed.money_armed_at = null;
  const cardPlan = parityCards({
    parity,
    base: baseCards,
    drivers,
    heroCode: carrier.heroCode ?? null,
    avoid: new Set([disarmed.id]),
    anchor,
    zone,
  });

  const rows: TenantRows = {
    customers,
    drivers,
    driver_cards: cardPlan.cards,
    driver_identities: driverIdentities(parity, drivers, prefix),
    driver_arm_events: armEvents(parity, drivers),
    loads,
    load_state_miles: stateMiles,
    load_accessorials: accessorials,
    driver_days: days,
    fuel_purchases: fuelPurchases,
    pay_configs: versions.map(({ effective_from, note, ...knobs }) => ({
      id: newId(),
      effective_from,
      note,
      source: "seed" as const,
      ...knobs,
    })),
    deduction_schedules: schedules,
    settlement_periods: settlementPeriods,
    settlements: [],
    settlement_lines: [],
    pay_items: payItems,
    advances,
    invoices: ar.invoices,
    customer_payments: ar.payments,
    payment_applications: ar.applications,
    untrusted_inputs: [],
    screenings: [],
    briefs: [],
  };
  applyHistory({ slug, zone, rows, newId });
  // The take-back is recorded after history, which never recovered from it, so no settled week moves.
  const takenBack = plantTakeBack(rows.advances, takenBackId);
  // Outside text for the agent's screener, from its own id stream so no other row changes.
  rows.untrusted_inputs = buildUntrustedInputs({ carrier, anchor, rows });

  const plan: CarrierPlan = {
    carrier,
    anchor,
    periods,
    victims: { ...victims, ...fuelVictims, fuelDuplicate: v11.code },
    planted: {
      duplicateAdvanceIds: [dupA.id, dupB.id],
      wrongDriverFuelItemId: wrongFuelItem.id,
      wrongDriverPurchaseId: wrongPurchase.id,
      dispatchDayId: dispatchDay.id,
      unreimbursedLumperId: plantedLumper.id,
      noRateLoadId: noRateLoad.row.id,
      overLimitAdvanceIds: [over1.id, over2.id],
      wrongInvoice: ar.wrongInvoice,
      fuelOffRouteId: offRoute.id,
      fuelOverTankId: overTank.id,
      fuelParkedId: parked.id,
      fuelDuplicateIds: [dupOlder.id, dupNewer.id],
      fuelDuplicatePaybackIds: [dupPaybacks[0].id, dupPaybacks[1].id],
      detentionLoadIds: detentionLoads.map((x) => x.row.id),
      collections: ar.collections,
      invoiceReview,
      parity: {
        disarmedDriverId: disarmed.id,
        loadPairLoadId: pair.loadId,
        loadPairAdvanceIds: [pair.rows[0].id, pair.rows[1].id],
        takenBackAdvanceId: takenBack.id,
        extraCardId: cardPlan.extra,
        genericCardId: cardPlan.generic,
        closedCardId: cardPlan.closed,
      },
    },
    rows,
  };
  assertPlan(plan);
  return plan;
}
