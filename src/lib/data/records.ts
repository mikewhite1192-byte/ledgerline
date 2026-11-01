import { flags, type Flags } from "../../config/flags";
import {
  cents,
  ConfigError,
  dueWeek,
  hardDeductionLines,
  InputError,
  PAID_STATUSES,
  parsePayConfig,
  sub,
  sum,
  type AdvanceRecord,
  type CashFridayInput,
  type CashFridayLimits,
  type CashSettingsRecord,
  type Cents,
  type CheckInput,
  type CustomerPaymentRecord,
  type CustomerRecord,
  type DeficitRecord,
  type DeficitSource,
  type DriverDayRecord,
  type DriverRecord,
  type FuelPurchaseRecord,
  type InvoiceRecord,
  type LoadRecord,
  type LoadStopsRecord,
  type PayConfig,
  type PayItemRecord,
  type PaymentApplicationRecord,
  type ReceivablesInput,
  type ScheduleRecord,
  type SettlementInput,
  type SettlementPeriodRecord,
  type SettlementRecord,
  type VendorBillRecord,
} from "../rules-engine";
import { localDateOf, periodContaining, type LocalDate, type Period } from "../time/local-date";
import { checkVersionOf, configFor, sortVersions } from "./config-version";
import type {
  AdvanceRow,
  CashSettingsRow,
  CustomerPaymentRow,
  CustomerRow,
  DeductionScheduleRow,
  DriverDayRow,
  DriverRow,
  FuelPurchaseRow,
  InvoiceRow,
  LoadAccessorialRow,
  LoadRow,
  LoadStateMilesRow,
  PayConfigKnobs,
  PayItemRow,
  PaymentApplicationRow,
  SettlementPeriodRow,
  SettlementRow,
  TenantRows,
  VendorBillRow,
} from "./rows";

// Table rows (snake_case, as stored) to the engine's records (camelCase, money as Cents). The seed
// maps its in-memory plan through these and the readers map what the database returns through the
// same functions, so a seeded row and a row read back become the same record.

const c = (value: number): Cents => cents(value);
const cn = (value: number | null): Cents | null => (value === null ? null : cents(value));

export function payConfigOf(row: PayConfigKnobs): PayConfig {
  return parsePayConfig(row as unknown as Record<string, unknown>);
}

export function customerOf(r: CustomerRow): CustomerRecord {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    termsDays: r.terms_days,
    city: r.city,
    state: r.state,
    detentionFreeMinutes: r.detention_free_minutes,
    detentionHourlyCents: c(r.detention_hourly_cents),
  };
}

export function driverOf(r: DriverRow): DriverRecord {
  return {
    id: r.id,
    code: r.code,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    workerType: r.worker_type,
    payBasis: r.pay_basis,
    perMileCents: cn(r.per_mile_cents),
    percentBps: r.percent_bps,
    flatPerLoadCents: cn(r.flat_per_load_cents),
    advanceLimitCents: cn(r.advance_limit_cents),
    escrowBalanceCents: c(r.escrow_balance_cents),
    ownInsurance: r.own_insurance,
    truckUnit: r.truck_unit,
    tankGallons: r.tank_gallons,
    activeFrom: r.active_from,
    activeTo: r.active_to,
    moneyArmed: r.money_armed,
  };
}

// Loads with their state miles and accessorials attached, in the order the loads were given.
export function loadsOf(
  loads: readonly LoadRow[],
  stateMiles: readonly LoadStateMilesRow[],
  accessorials: readonly LoadAccessorialRow[],
): LoadRecord[] {
  const miles = new Map<string, LoadStateMilesRow[]>();
  for (const m of stateMiles) miles.set(m.load_id, [...(miles.get(m.load_id) ?? []), m]);
  const extras = new Map<string, LoadAccessorialRow[]>();
  for (const a of accessorials) extras.set(a.load_id, [...(extras.get(a.load_id) ?? []), a]);
  return loads.map((r) => ({
    id: r.id,
    loadNumber: r.load_number,
    customerId: r.customer_id,
    driverId: r.driver_id,
    status: r.status,
    originCity: r.origin_city,
    originState: r.origin_state,
    destCity: r.dest_city,
    destState: r.dest_state,
    pickupOn: r.pickup_on,
    deliveredOn: r.delivered_on,
    deliveredAt: r.delivered_at,
    loadedMiles: r.loaded_miles,
    emptyMiles: r.empty_miles,
    linehaulCents: cn(r.linehaul_cents),
    fuelSurchargeCents: c(r.fuel_surcharge_cents),
    stateMiles: (miles.get(r.id) ?? []).map((m) => ({ id: m.id, state: m.state, miles: m.miles })),
    accessorials: (extras.get(r.id) ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      seq: a.seq,
      amountCents: c(a.amount_cents),
      paidByDriver: a.paid_by_driver,
      description: a.description,
    })),
  }));
}

export function loadStopsOf(r: LoadRow): LoadStopsRecord {
  return {
    id: r.id,
    loadNumber: r.load_number,
    customerId: r.customer_id,
    deliveredOn: r.delivered_on,
    pickupArrivedAt: r.pickup_arrived_at,
    pickupDepartedAt: r.pickup_departed_at,
    deliveryArrivedAt: r.delivery_arrived_at,
    deliveryDepartedAt: r.delivery_departed_at,
  };
}

export function dayOf(r: DriverDayRow): DriverDayRecord {
  return { id: r.id, driverId: r.driver_id, day: r.day, source: r.source, loadId: r.load_id };
}

export function fuelPurchaseOf(r: FuelPurchaseRow): FuelPurchaseRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    loadId: r.load_id,
    purchasedAt: r.purchased_at,
    purchasedOn: r.purchased_on,
    state: r.state,
    gallonsMilli: r.gallons_milli,
    amountCents: c(r.amount_cents),
    paidWith: r.paid_with,
    purchaseRef: r.purchase_ref,
  };
}

export function scheduleOf(r: DeductionScheduleRow): ScheduleRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    kind: r.kind,
    amountCents: c(r.amount_cents),
    targetCents: cn(r.target_cents),
    description: r.description,
    activeFrom: r.active_from,
    activeTo: r.active_to,
  };
}

export function payItemOf(r: PayItemRow): PayItemRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    kind: r.kind,
    subkind: r.subkind,
    amountCents: c(r.amount_cents),
    itemDate: r.item_date,
    refTable: r.ref_table,
    refId: r.ref_id,
    itemRef: r.item_ref,
    description: r.description,
    settlementId: r.settlement_id,
    enteredBy: r.entered_by,
  };
}

export function advanceOf(r: AdvanceRow): AdvanceRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    requestRef: r.request_ref,
    requestedAt: r.requested_at,
    requestedOn: r.requested_on,
    amountCents: c(r.amount_cents),
    feeCents: c(r.fee_cents),
    status: r.status,
    recoveredCents: c(r.recovered_cents),
    source: r.source,
    reasonCategory: r.reason_category,
    paidAt: r.paid_at,
    loadId: r.load_id,
    takenBackCents: c(r.taken_back_cents),
  };
}

// One driver_deficits row as the settlement input reads it (0078, 0080). Not a seeded table: the
// seed writes no deficits, so a demo week recovers none. created_on is created_at as the tenant's
// own date, worked out by the reader in the tenant's zone.
export type DeficitRow = {
  id: string;
  driver_id: string;
  amount_cents: number;
  recovered_cents: number;
  created_at: string;
  created_on: LocalDate;
  source_kind: DeficitSource;
  note: string;
};

export function deficitOf(r: DeficitRow): DeficitRecord {
  return {
    id: r.id,
    driverId: r.driver_id,
    amountCents: c(r.amount_cents),
    recoveredCents: c(r.recovered_cents),
    createdAt: r.created_at,
    createdOn: r.created_on,
    sourceKind: r.source_kind,
    note: r.note,
  };
}

// Whether a pay period takes deficits back: only while deficit recovery is on, and only for a
// period ending on or after its start date (the carrier's dates), so turning it on never rewrites
// an older stub.
export function deficitRecoveryApplies(period: Period, f: Pick<Flags, "deficitRecovery"> = flags): boolean {
  return f.deficitRecovery.enabled === true && period.end >= f.deficitRecovery.startDate;
}

export function periodOf(r: SettlementPeriodRow): SettlementPeriodRecord {
  return { id: r.id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status };
}

// A stored settlement: the engine's totals for one driver and week, as the pay run saved them.
export function settlementOf(r: SettlementRow): SettlementRecord {
  return {
    id: r.id,
    periodId: r.period_id,
    driverId: r.driver_id,
    status: r.status,
    grossCents: c(r.gross_cents),
    deductionsCents: c(r.deductions_cents),
    netCents: c(r.net_cents),
    carryForwardCents: c(r.carry_forward_cents),
    exceptionCount: r.exception_count,
    paidAt: r.paid_at,
  };
}

export function invoiceOf(r: InvoiceRow): InvoiceRecord {
  return {
    id: r.id,
    source: r.source,
    loadId: r.load_id,
    customerId: r.customer_id,
    invoiceNumber: r.invoice_number,
    amountCents: c(r.amount_cents),
    issuedOn: r.issued_on,
    dueOn: r.due_on,
    status: r.status,
    paidOn: r.paid_on,
    qboId: r.qbo_id,
  };
}

export function paymentOf(r: CustomerPaymentRow): CustomerPaymentRecord {
  return {
    id: r.id,
    customerId: r.customer_id,
    receivedOn: r.received_on,
    amountCents: c(r.amount_cents),
    method: r.method,
    paymentRef: r.payment_ref,
    source: r.source,
    memo: r.memo,
    qboId: r.qbo_id,
  };
}

export function applicationOf(r: PaymentApplicationRow): PaymentApplicationRecord {
  return { id: r.id, paymentId: r.payment_id, invoiceId: r.invoice_id, amountCents: c(r.amount_cents) };
}

export function vendorBillOf(r: VendorBillRow): VendorBillRecord {
  return {
    id: r.id,
    billRef: r.bill_ref,
    vendorName: r.vendor_name,
    category: r.category,
    amountCents: c(r.amount_cents),
    dueOn: r.due_on,
    urgency: r.urgency,
    status: r.status,
    deferredTo: r.deferred_to,
    paidOn: r.paid_on,
  };
}

export function cashSettingsOf(r: CashSettingsRow): CashSettingsRecord {
  return {
    id: r.id,
    bankBalanceCents: c(r.bank_balance_cents),
    balanceAsOf: r.balance_as_of,
    payDayDow: r.pay_day_dow,
    factoringAdvanceBps: r.factoring_advance_bps,
    factoringFeeBps: r.factoring_fee_bps,
  };
}

// ---- Whole inputs, from one tenant's rows ----

// Everything the six pay checks read, under the open period's pay rules version.
export function checkInputOf(
  rows: Pick<
    TenantRows,
    | "pay_configs"
    | "settlement_periods"
    | "drivers"
    | "loads"
    | "load_state_miles"
    | "load_accessorials"
    | "driver_days"
    | "fuel_purchases"
    | "pay_items"
    | "advances"
  >,
): CheckInput {
  return {
    config: payConfigOf(checkVersionOf(rows.pay_configs, rows.settlement_periods)),
    drivers: rows.drivers.map(driverOf),
    loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
    days: rows.driver_days.map(dayOf),
    fuelPurchases: rows.fuel_purchases.map(fuelPurchaseOf),
    items: rows.pay_items.map(payItemOf),
    advances: rows.advances.map(advanceOf),
  };
}

// What a driver's other unpaid stubs before a week hold on the balances a week draws down
// (readHeldRecoveries, D-090): advance and deficit recoveries by the record's id in lower case,
// and the escrow those stubs withhold.
export type HeldRecoveries = {
  advances: ReadonlyMap<string, number>;
  deficits: ReadonlyMap<string, number>;
  escrowCents: number;
};

export const NOTHING_HELD: HeldRecoveries = { advances: new Map(), deficits: new Map(), escrowCents: 0 };

// The driver's rows as the week reads them: what is held counts as recovered already, never past
// what is still owed (an advance's amount and fee less what a person took back, which checkAdvance
// refuses past; a deficit's amount), and the escrow held counts toward the balance. Held never
// lowers what the record says, so a bad record still fails the engine's own check. Pure; rows of
// other drivers pass through unchanged.
export function applyHeld<
  R extends Pick<TenantRows, "drivers" | "advances"> & { driver_deficits?: readonly DeficitRow[] },
>(rows: R, driverId: string, held: HeldRecoveries): R {
  const heldOn = (map: ReadonlyMap<string, number>, id: string) => c(map.get(id.toLowerCase()) ?? 0);
  return {
    ...rows,
    drivers: rows.drivers.map((d) =>
      d.id !== driverId || held.escrowCents === 0
        ? d
        : { ...d, escrow_balance_cents: sum([c(d.escrow_balance_cents), c(held.escrowCents)]) },
    ),
    advances: rows.advances.map((a) => {
      const h = a.driver_id === driverId ? heldOn(held.advances, a.id) : 0;
      if (h === 0) return a;
      const owed = sub(sum([c(a.amount_cents), c(a.fee_cents)]), c(a.taken_back_cents));
      const recovered = Math.max(a.recovered_cents, Math.min(owed, sum([c(a.recovered_cents), h])));
      return { ...a, recovered_cents: recovered };
    }),
    ...(rows.driver_deficits
      ? {
          driver_deficits: rows.driver_deficits.map((d) => {
            const h = d.driver_id === driverId ? heldOn(held.deficits, d.id) : 0;
            if (h === 0) return d;
            return { ...d, recovered_cents: Math.max(d.recovered_cents, Math.min(d.amount_cents, sum([c(d.recovered_cents), h]))) };
          }),
        }
      : {}),
  };
}

// One driver's settlement for one period, under the version that period runs on, from the
// escrow balance the driver holds now. The driver's deficits count only while deficit recovery
// applies to the period (deficitRecoveryApplies); otherwise the input carries none. Rows without
// driver_deficits (the seed's plan) carry none either. A what-if preview that calls this on
// readTenantRows (Cash Friday, the sweep's plan, a pay rule change, the seed summary) carries no
// deficits and no live card pull hold (NO_LIVE_PULL, read.ts), so once deficit recovery is on a
// preview's net can differ from the pay run's (readSettlementInput).
export function settlementInputOf(
  rows: Pick<
    TenantRows,
    | "pay_configs"
    | "drivers"
    | "loads"
    | "load_state_miles"
    | "load_accessorials"
    | "driver_days"
    | "pay_items"
    | "deduction_schedules"
    | "advances"
  > & { driver_deficits?: readonly DeficitRow[] },
  driverId: string,
  period: Period,
): SettlementInput {
  const driver = rows.drivers.find((d) => d.id === driverId);
  if (!driver) throw new Error("no such driver");
  const loads = rows.loads.filter((l) => l.driver_id === driverId);
  const ids = new Set(loads.map((l) => l.id));
  return {
    config: payConfigOf(configFor(rows.pay_configs, period.start)),
    driver: driverOf(driver),
    period,
    loads: loadsOf(
      loads,
      rows.load_state_miles.filter((m) => ids.has(m.load_id)),
      rows.load_accessorials.filter((a) => ids.has(a.load_id)),
    ),
    days: rows.driver_days.filter((d) => d.driver_id === driverId).map(dayOf),
    items: rows.pay_items.filter((i) => i.driver_id === driverId).map(payItemOf),
    schedules: rows.deduction_schedules.filter((x) => x.driver_id === driverId).map(scheduleOf),
    advances: rows.advances.filter((a) => a.driver_id === driverId).map(advanceOf),
    deficits: deficitRecoveryApplies(period)
      ? (rows.driver_deficits ?? []).filter((d) => d.driver_id === driverId).map(deficitOf)
      : [],
    escrowBalanceCents: c(driver.escrow_balance_cents),
  };
}

// Invoices, payments and applications, aged as of a tenant-local date.
export function receivablesInputOf(
  rows: Pick<TenantRows, "invoices" | "customer_payments" | "payment_applications">,
  asOf: LocalDate,
): ReceivablesInput {
  return {
    invoices: rows.invoices.map(invoiceOf),
    payments: rows.customer_payments.map(paymentOf),
    applications: rows.payment_applications.map(applicationOf),
    asOf,
  };
}

export type CashFridayRows = Pick<
  TenantRows,
  | "pay_configs"
  | "settlement_periods"
  | "settlements"
  | "drivers"
  | "loads"
  | "load_state_miles"
  | "load_accessorials"
  | "driver_days"
  | "pay_items"
  | "deduction_schedules"
  | "advances"
  | "invoices"
  | "customer_payments"
  | "payment_applications"
  | "vendor_bills"
  | "cash_settings"
  | "factoring_request_invoices"
>;

// Everything Cash Friday reads (design 4.2). Paid instants become dates in the tenant's zone here,
// so the engine sees only dates. The pay run preview is one settlement input per driver active in
// the week paid next (dueWeekOf); when no week is open, the held lines did not read (held null),
// or a driver's input cannot be built (no pay rules version for the week, a record that does not
// fit), previews are null and the engine refuses the pay run as unknown rather than counting it
// as zero. held defaults to nothing held, as for the seed's plan (one open week, every older week
// paid, so no unpaid stub holds anything). An invoice with a live factoring
// line (any status but declined or failed: submitted, unknown and funded all mean the partner may
// hold it) is marked factored, so the engine neither counts its receipt nor offers it again.
export function cashFridayInputOf(
  rows: CashFridayRows,
  zone: string,
  limits: CashFridayLimits,
  held: ReadonlyMap<string, HeldRecoveries> | null = new Map(),
): CashFridayInput {
  if (rows.cash_settings.length > 1) throw new Error("more than one cash settings row");
  const paidOn = (at: string | null): LocalDate | null => (at === null ? null : localDateOf(at, zone));
  const factored = factoredInvoiceIds(rows.factoring_request_invoices);
  return {
    settings: rows.cash_settings.length === 1 ? cashSettingsOf(rows.cash_settings[0]) : null,
    periods: rows.settlement_periods.map(periodOf),
    settlements: rows.settlements.map((r) => ({ ...settlementOf(r), paidOn: paidOn(r.paid_at) })),
    payDays: payDaysOf(rows),
    previews: previewsOf(rows, held),
    advances: rows.advances.map((r) => ({ ...advanceOf(r), paidOn: paidOn(r.paid_at) })),
    invoices: rows.invoices.map((r) => (factored.has(r.id) ? { ...invoiceOf(r), factored: true } : invoiceOf(r))),
    payments: rows.customer_payments.map(paymentOf),
    applications: rows.payment_applications.map(applicationOf),
    bills: rows.vendor_bills.map(vendorBillOf),
    limits,
  };
}

// The invoices a factoring line still holds: every line but a declined or failed one.
export function factoredInvoiceIds(lines: readonly { invoice_id: string; status: string }[]): Set<string> {
  return new Set(lines.filter((l) => l.status !== "declined" && l.status !== "failed").map((l) => l.invoice_id));
}

// The days that carry pay (dueWeek), each one a day "Run the week" drafts a paystub for: a load a
// driver delivered (delivered or invoiced, as the engine pays it), a pay item (every kind makes a
// line), and a day worked only where it makes a line on its own (dayDrafts).
export function payDaysOf(
  rows: Pick<TenantRows, "loads" | "pay_items" | "driver_days" | "pay_configs" | "drivers" | "deduction_schedules">,
): LocalDate[] {
  const drafts = dayDrafts(rows);
  return [
    ...rows.loads
      .filter((l) => l.driver_id !== null && l.delivered_on !== null && PAID_STATUSES.includes(l.status))
      .map((l) => l.delivered_on as LocalDate),
    ...rows.pay_items.map((i) => i.item_date),
    ...rows.driver_days.filter(drafts).map((d) => d.day),
  ];
}

// Whether a day worked drafts a paystub with no load or pay item beside it: only through the
// deductions the engine always takes (hardDeductionLines: insurance for the drivers it applies to,
// a lease or other scheduled deduction active that week), since with no gross nothing else makes a
// line. A company driver's day with no insurance and no schedule drafts nothing, so it never holds
// the week paid next back. A day whose driver, week or pay rules do not read counts, as it did
// (unknown is not "drafts nothing"), so the week stays the one reported and its previews decide.
// One answer per driver and week.
function dayDrafts(
  rows: Pick<TenantRows, "driver_days" | "pay_configs" | "drivers" | "deduction_schedules">,
): (d: DriverDayRow) => boolean {
  const seen = new Map<string, boolean>();
  return (d) => {
    const driver = rows.drivers.find((x) => x.id === d.driver_id);
    if (!driver) return true;
    try {
      const week = periodContaining(d.day, sortVersions(rows.pay_configs)[0].week_start_dow);
      const key = `${d.driver_id}:${week.start}`;
      const known = seen.get(key);
      if (known !== undefined) return known;
      const lines = hardDeductionLines(
        payConfigOf(configFor(rows.pay_configs, week.start)),
        driverOf(driver),
        week,
        [],
        rows.deduction_schedules.filter((x) => x.driver_id === d.driver_id).map(scheduleOf),
        rows.driver_days.filter((x) => x.driver_id === d.driver_id).map(dayOf),
      ).lines;
      seen.set(key, lines.length > 0);
      return lines.length > 0;
    } catch {
      return true;
    }
  };
}

// The week Cash Friday reports (dueWeek, D-090), as its row.
export function dueWeekOf(
  rows: Pick<
    CashFridayRows,
    "settlement_periods" | "settlements" | "loads" | "pay_items" | "driver_days" | "pay_configs" | "drivers" | "deduction_schedules"
  >,
): SettlementPeriodRow | null {
  const due = dueWeek(
    rows.settlement_periods.map(periodOf),
    rows.settlements.map((s) => ({ periodId: s.period_id })),
    payDaysOf(rows),
  );
  return due ? (rows.settlement_periods.find((p) => p.id === due.id) ?? null) : null;
}

// The previews describe the week Cash Friday reports (dueWeekOf), so the pay run total and the
// previews are one week's. Each driver's preview reads what the driver's other unpaid stubs hold
// (held, by driver id in lower case, from heldByDriver for that week), as a run of the week does,
// so a preview and the run agree; a driver missing from it holds nothing, and null (the held lines did
// not read) makes the previews null, so the pay run reads unknown.
function previewsOf(rows: CashFridayRows, held: ReadonlyMap<string, HeldRecoveries> | null): SettlementInput[] | null {
  const due = dueWeekOf(rows);
  if (!due || held === null) return null;
  const period: Period = { start: due.period_start, end: due.period_end };
  const active = rows.drivers
    .filter((d) => d.active_from <= period.end && (d.active_to === null || d.active_to >= period.start))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  try {
    return active.map((d) => settlementInputOf(applyHeld(rows, d.id, held.get(d.id.toLowerCase()) ?? NOTHING_HELD), d.id, period));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof InputError) return null;
    throw error;
  }
}
