import { loadsOf, payConfigOf } from "../data/records";
import type {
  AdvanceRow,
  CustomerRow,
  DeductionScheduleRow,
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
import { buildReceivables, type WrongInvoicePlant } from "./ar-plan";
import { assertPlan, seededAdvanceDecision } from "./assert-plan";
import { instantAt } from "./calendar";
import type { DemoCarrier } from "./carriers";
import { applyHistory } from "./history";
import { HERO_LANES, LANES, laneMiles, reverseLane, type Lane } from "./lanes";
import { CUSTOMERS, FIRST_NAMES, LAST_NAMES } from "./names";
import { Rng } from "./prng";

// buildCarrierPlan(carrier, anchor): every row the seed writes for one demo carrier, built in
// memory from nothing but the carrier constants and the anchor date (never the clock), so the
// same anchor always gives the same rows and the same ids. The four pay periods are the four
// weeks of the carrier's week shape that end on or before anchor - 1: three settled by the engine
// (history.ts), the last one open. The plan is checked whole (assert-plan.ts) before anything
// can be written.

type Role = "company_mile" | "company_flat" | "oo_leased" | "oo_owned";

const ROLE_MIX: readonly (readonly [Role, number])[] = [
  ["company_mile", 11],
  ["company_flat", 2],
  ["oo_leased", 6],
  ["oo_owned", 6],
];

// The drivers (codes) who carry the six planted pay problems; never the hero, all distinct.
export type Victims = {
  duplicateAdvance: string;
  fuelItemDriver: string;
  fuelLoadDriver: string;
  dayNotDriven: string;
  missingReimbursement: string;
  noRate: string;
  overLimit: string;
};

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

export function buildCarrierPlan(carrier: DemoCarrier, anchor: LocalDate): CarrierPlan {
  if (!isLocalDate(anchor)) throw new Error("anchor is not a YYYY-MM-DD date");
  const zone = carrier.timezone;
  const config = carrier.payConfig;
  const seed = `${carrier.slug}:${anchor}`;
  const rng = new Rng(`${seed}:plan`);
  const ids = new Rng(`${seed}:ids`);
  const newId = () => ids.uuid();
  const { prefix, slug } = carrier;
  const lanes = LANES[prefix];
  const periods = planPeriods(anchor, config.week_start_dow);
  const openWeek = periods[3];

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
      active_from: addDays(anchor, -rng.int(120, 1500)),
      active_to: null,
    };
  });
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
  const victims: Victims = {
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
    x: LoadDraft,
    day: LocalDate,
    [hour, minute]: [number, number],
    state: string,
    gallonsMilli: number,
    priceCents: number,
  ) => {
    const at = instantAt(day, hour, minute, zone);
    const row: FuelPurchaseRow = {
      id: newId(),
      driver_id: x.row.driver_id!,
      load_id: x.row.id,
      purchased_at: at,
      purchased_on: localDateOf(at, zone),
      state,
      gallons_milli: gallonsMilli,
      amount_cents: roundHalfUp(gallonsMilli * priceCents, 1000),
      paid_with: roleOf.get(x.driverCode) === "oo_owned" ? "driver_own" : "company_card",
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
      addFuel(x, day, time, state, rng.int(60000, 140000), rng.int(340, 420));
    }
  }
  // Planted: a company-card purchase by victim 3 on victim 3's load, deducted below from
  // victim 2.
  const v3Load = drafts.find((x) => x.driverCode === victims.fuelLoadDriver && x.week === 3);
  if (!v3Load) throw new Error("victim 3 has no load in the open week");
  const v3State = v3Load.lane.states[0][0];
  const wrongPurchase = addFuel(v3Load, v3Load.row.pickup_on, [14, 20], v3State, 71600, 400);
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

  // ---- Advances ----
  type AdvanceDraft = Omit<AdvanceRow, "request_ref"> & { ref?: string };
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
      fee_cents: config.advance_fee_cents,
      status: "paid",
      recovered_cents: 0,
      source: "seed",
      reason_category: null,
      paid_at: new Date(Date.parse(at) + paidAfterMinutes * 60_000).toISOString(),
      ref,
    };
    advanceDrafts.push(row);
    return row;
  };
  // One advance each for fourteen other drivers: ten in the settled weeks, four in the open week.
  // Each is one the engine grants when asked: requested a day or two after the driver's first
  // delivery that week, for no more than the most the engine allows on that day's earnings.
  const loadRecords = loadsOf(loads, stateMiles, accessorials);
  const most = (d: DriverRow, at: string) =>
    seededAdvanceDecision({
      config: payConfigOf(config),
      driver: d,
      loads: loadRecords,
      periods,
      zone,
      at,
      amountCents: config.advance_min_cents,
      prior: [],
    }).maxCents;
  const ownAdvances = new Set([carrier.heroCode, victims.duplicateAdvance, victims.overLimit]);
  let placed = 0;
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
    advance(d, day, time, amount, rng.int(20, 90));
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
    slug,
    prefix,
    anchor,
    rng: new Rng(`${seed}:receivables`),
    newId,
    customers,
    windowLoads: loadsOf(windowLoads, stateMiles, accessorials),
  });

  const rows: TenantRows = {
    customers,
    drivers,
    loads,
    load_state_miles: stateMiles,
    load_accessorials: accessorials,
    driver_days: days,
    fuel_purchases: fuelPurchases,
    pay_configs: [{ ...config }],
    deduction_schedules: schedules,
    settlement_periods: settlementPeriods,
    settlements: [],
    settlement_lines: [],
    pay_items: payItems,
    advances,
    invoices: ar.invoices,
    customer_payments: ar.payments,
    payment_applications: ar.applications,
  };
  applyHistory({ slug, zone, config: payConfigOf(config), rows, newId });

  const plan: CarrierPlan = {
    carrier,
    anchor,
    periods,
    victims,
    planted: {
      duplicateAdvanceIds: [dupA.id, dupB.id],
      wrongDriverFuelItemId: wrongFuelItem.id,
      wrongDriverPurchaseId: wrongPurchase.id,
      dispatchDayId: dispatchDay.id,
      unreimbursedLumperId: plantedLumper.id,
      noRateLoadId: noRateLoad.row.id,
      overLimitAdvanceIds: [over1.id, over2.id],
      wrongInvoice: ar.wrongInvoice,
    },
    rows,
  };
  assertPlan(plan);
  return plan;
}
