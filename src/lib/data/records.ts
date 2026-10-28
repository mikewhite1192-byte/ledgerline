import {
  cents,
  ConfigError,
  InputError,
  parsePayConfig,
  type AdvanceRecord,
  type CashFridayInput,
  type CashFridayLimits,
  type CashSettingsRecord,
  type Cents,
  type CheckInput,
  type CustomerPaymentRecord,
  type CustomerRecord,
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
import { localDateOf, type LocalDate, type Period } from "../time/local-date";
import { checkVersionOf, configFor } from "./config-version";
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

// One driver's settlement for one period, under the version that period runs on, from the
// escrow balance the driver holds now.
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
  >,
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
>;

// Everything Cash Friday reads (design 4.2). Paid instants become dates in the tenant's zone here,
// so the engine sees only dates. The pay run preview is one settlement input per driver active in
// the one open week; when the week is not exactly one, or a driver's input cannot be built (no
// pay rules version for the week, a record that does not fit), previews are null and the engine
// refuses the pay run as unknown rather than counting it as zero.
export function cashFridayInputOf(
  rows: CashFridayRows,
  zone: string,
  limits: CashFridayLimits,
): CashFridayInput {
  if (rows.cash_settings.length > 1) throw new Error("more than one cash settings row");
  const paidOn = (at: string | null): LocalDate | null => (at === null ? null : localDateOf(at, zone));
  return {
    settings: rows.cash_settings.length === 1 ? cashSettingsOf(rows.cash_settings[0]) : null,
    periods: rows.settlement_periods.map(periodOf),
    settlements: rows.settlements.map((r) => ({ ...settlementOf(r), paidOn: paidOn(r.paid_at) })),
    previews: previewsOf(rows),
    advances: rows.advances.map((r) => ({ ...advanceOf(r), paidOn: paidOn(r.paid_at) })),
    invoices: rows.invoices.map(invoiceOf),
    payments: rows.customer_payments.map(paymentOf),
    applications: rows.payment_applications.map(applicationOf),
    bills: rows.vendor_bills.map(vendorBillOf),
    limits,
  };
}

function previewsOf(rows: CashFridayRows): SettlementInput[] | null {
  const open = rows.settlement_periods.filter((p) => p.status === "open");
  if (open.length !== 1) return null;
  const period: Period = { start: open[0].period_start, end: open[0].period_end };
  const active = rows.drivers
    .filter((d) => d.active_from <= period.end && (d.active_to === null || d.active_to >= period.start))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  try {
    return active.map((d) => settlementInputOf(rows, d.id, period));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof InputError) return null;
    throw error;
  }
}
