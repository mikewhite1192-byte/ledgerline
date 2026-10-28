import type { Queryable } from "../db";
import { ConfigError } from "../rules-engine";
import { configForDay } from "../data/config-version";
import { readPayConfigVersions, readRowsWhereId } from "../data/read";
import type { DriverRow, PayItemRow } from "../data/rows";
import { nameOf } from "../settlements/list";

// The small record pages a paystub line links to: a pay item, a day driven, a deduction schedule,
// and the extra charge that sends the reader to its load. Every read goes through the scoped
// helpers in src/lib/data/read.ts (each names its tenant) inside the request's tenant
// transaction; nothing here writes or computes pay.

export type DriverRef = { id: string; name: string; code: string };
export type LinkedRef = { table: string; id: string; label: string };
export type PaystubRef = { id: string; periodStart: string; periodEnd: string };

async function one<T>(rows: Promise<T[]>): Promise<T | null> {
  const [row] = await rows;
  return row ?? null;
}

async function driverRef(q: Queryable, id: string): Promise<(DriverRef & { row: DriverRow }) | null> {
  const d = await one(readRowsWhereId(q, "drivers", "id", id));
  return d ? { id: d.id, name: nameOf(d.first_name, d.last_name), code: d.code, row: d } : null;
}

async function loadRef(q: Queryable, id: string): Promise<LinkedRef | null> {
  const l = await one(readRowsWhereId(q, "loads", "id", id));
  return l ? { table: "loads", id: l.id, label: `Load ${l.load_number}` } : null;
}

async function paystubRef(q: Queryable, settlementId: string): Promise<PaystubRef | null> {
  const s = await one(readRowsWhereId(q, "settlements", "id", settlementId));
  if (!s) return null;
  const p = await one(readRowsWhereId(q, "settlement_periods", "id", s.period_id));
  return p ? { id: s.id, periodStart: p.period_start, periodEnd: p.period_end } : null;
}

// ---- Pay item: a reimbursement, a fuel charge, a deduction or a carried shortfall ----

// What the item is for, as the page shows it: a load, the load an extra charge is on, the paystub
// a shortfall came from, a fuel purchase (no page of its own), or nothing.
export type PayItemFor =
  | { kind: "load"; load: LinkedRef }
  | { kind: "extra_charge"; load: LinkedRef; chargeId: string; chargeKind: string }
  | { kind: "paystub"; paystub: PaystubRef }
  | { kind: "fuel_purchase"; purchasedOn: string; state: string; amountCents: number }
  | { kind: "correction" }
  | { kind: "none" };

export type PayItemView = {
  id: string;
  kind: PayItemRow["kind"];
  subkind: string;
  amountCents: number;
  itemDate: string;
  description: string;
  correction: boolean;
  driver: DriverRef | null;
  for: PayItemFor;
  paidOn: PaystubRef | null;
};

async function payItemFor(q: Queryable, item: PayItemRow): Promise<PayItemFor> {
  if (item.ref_table === "proposals") return { kind: "correction" };
  if (item.ref_id === null) return { kind: "none" };
  switch (item.ref_table) {
    case "loads": {
      const load = await loadRef(q, item.ref_id);
      return load ? { kind: "load", load } : { kind: "none" };
    }
    case "load_accessorials": {
      const charge = await one(readRowsWhereId(q, "load_accessorials", "id", item.ref_id));
      const load = charge ? await loadRef(q, charge.load_id) : null;
      return charge && load ? { kind: "extra_charge", load, chargeId: charge.id, chargeKind: charge.kind } : { kind: "none" };
    }
    case "settlements": {
      const paystub = await paystubRef(q, item.ref_id);
      return paystub ? { kind: "paystub", paystub } : { kind: "none" };
    }
    case "fuel_purchases": {
      const f = await one(readRowsWhereId(q, "fuel_purchases", "id", item.ref_id));
      return f ? { kind: "fuel_purchase", purchasedOn: f.purchased_on, state: f.state, amountCents: f.amount_cents } : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

export async function readPayItemView(q: Queryable, id: string): Promise<PayItemView | null> {
  const item = await one(readRowsWhereId(q, "pay_items", "id", id));
  if (!item) return null;
  const driver = await driverRef(q, item.driver_id);
  return {
    id: item.id,
    kind: item.kind,
    subkind: item.subkind,
    amountCents: item.amount_cents,
    itemDate: item.item_date,
    description: item.description,
    correction: item.ref_table === "proposals" || item.item_ref.startsWith("correction:"),
    driver: driver ? { id: driver.id, name: driver.name, code: driver.code } : null,
    for: await payItemFor(q, item),
    paidOn: item.settlement_id ? await paystubRef(q, item.settlement_id) : null,
  };
}

// ---- A day driven: the one insurance charge per day ----

export type DriverDayView = {
  id: string;
  day: string;
  source: "load" | "dispatch";
  driver: DriverRef | null;
  workerType: DriverRow["worker_type"] | null;
  ownInsurance: boolean;
  load: LinkedRef | null;
  // The pay rules version that week's paystub runs under; null when no version covers the day.
  rules: { effectiveFrom: string; note: string | null; perDayCents: number; appliesTo: "owner_operator" | "all" } | null;
};

export async function readDriverDayView(q: Queryable, id: string): Promise<DriverDayView | null> {
  const day = await one(readRowsWhereId(q, "driver_days", "id", id));
  if (!day) return null;
  const driver = await driverRef(q, day.driver_id);
  let rules: DriverDayView["rules"] = null;
  try {
    const v = configForDay(await readPayConfigVersions(q), day.day);
    rules = {
      effectiveFrom: v.effective_from,
      note: v.note,
      perDayCents: v.insurance_per_day_cents,
      appliesTo: v.insurance_applies_to,
    };
  } catch (err) {
    // No pay rules cover that week: the page says so. A failed read is not that, so it goes on.
    if (!(err instanceof ConfigError)) throw err;
    rules = null;
  }
  return {
    id: day.id,
    day: day.day,
    source: day.source,
    driver: driver ? { id: driver.id, name: driver.name, code: driver.code } : null,
    workerType: driver?.row.worker_type ?? null,
    ownInsurance: driver?.row.own_insurance ?? false,
    load: day.load_id ? await loadRef(q, day.load_id) : null,
    rules,
  };
}

// ---- A deduction schedule: escrow, a truck lease, or another weekly deduction ----

export type ScheduleView = {
  id: string;
  kind: "escrow" | "lease" | "other";
  amountCents: number;
  description: string;
  activeFrom: string;
  activeTo: string | null;
  driver: DriverRef | null;
  // Escrow only: what the driver has held now (null when the driver row could not be read) and the
  // amount it builds to.
  escrow: { balanceCents: number | null; targetCents: number | null } | null;
};

export async function readScheduleView(q: Queryable, id: string): Promise<ScheduleView | null> {
  const s = await one(readRowsWhereId(q, "deduction_schedules", "id", id));
  if (!s) return null;
  const driver = await driverRef(q, s.driver_id);
  let escrow: ScheduleView["escrow"] = null;
  if (s.kind === "escrow") {
    let target = s.target_cents;
    if (target === null) {
      // No target of its own: the carrier's newest pay rules set it.
      try {
        target = (await readPayConfigVersions(q)).at(-1)?.escrow_target_cents ?? null;
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
      }
    }
    escrow = { balanceCents: driver ? driver.row.escrow_balance_cents : null, targetCents: target };
  }
  return {
    id: s.id,
    kind: s.kind,
    amountCents: s.amount_cents,
    description: s.description,
    activeFrom: s.active_from,
    activeTo: s.active_to,
    driver: driver ? { id: driver.id, name: driver.name, code: driver.code } : null,
    escrow,
  };
}

// ---- An extra charge: the page is its load's "Extra charges" table ----

export async function readExtraChargeLoadId(q: Queryable, id: string): Promise<string | null> {
  const charge = await one(readRowsWhereId(q, "load_accessorials", "id", id));
  return charge ? charge.load_id : null;
}
