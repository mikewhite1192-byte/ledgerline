import {
  isLocalDate,
  parseInstant,
  type Instant,
  type LocalDate,
  type Period,
} from "../time/local-date";

// The shapes the rules engine computes over. The seed builds these records, the data readers
// return them, and every later item (settlements, advances, invoices, the agent's checks) passes
// them in. Field names are the table columns in camelCase; nothing here knows about the database.

export type { Instant, LocalDate, Period };

// Integer cents. A brand, so miles or basis points cannot be passed where money is expected.
// money.ts makes one (`cents`, `assertCents`) after checking it is a safe integer.
export type Cents = number & { readonly __brand: "Cents" };

// A config row that is missing, has a missing field, or has a value out of range. The math
// refuses to run rather than guess.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// A record that does not fit its shape: an unknown kind, a bad date, an amount that is not a
// safe integer, a record for another driver. Messages name the field and the record id, never
// the value (values can be free text).
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

// ---- Guards every module uses on the records it reads ----

export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(`${what} is not a known kind`);
  }
  return value as T;
}

export function assertId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new InputError(`${what} is missing`);
  return value;
}

export function assertDate(value: unknown, what: string): LocalDate {
  if (!isLocalDate(value)) throw new InputError(`${what} is not a YYYY-MM-DD date`);
  return value;
}

export function assertPeriod(period: Period | null | undefined): Period {
  if (!period || typeof period !== "object") throw new InputError("period is missing");
  const start = assertDate(period.start, "period start");
  const end = assertDate(period.end, "period end");
  if (end < start) throw new InputError("period ends before it starts");
  return { start, end };
}

// Milliseconds since the epoch, for comparing instants. Never the wall clock.
export function instantMs(value: unknown, what: string): number {
  try {
    return parseInstant(value);
  } catch {
    throw new InputError(`${what} is not an ISO instant with a zone`);
  }
}

// Plain code-unit order, the same on every machine (localeCompare depends on the locale).
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const TABLES = [
  "customers",
  "drivers",
  "loads",
  "load_state_miles",
  "load_accessorials",
  "driver_days",
  "fuel_purchases",
  "pay_configs",
  "deduction_schedules",
  "pay_items",
  "advances",
  "settlement_periods",
  "settlements",
  "settlement_lines",
  "invoices",
  "customer_payments",
  "payment_applications",
] as const;
export type TableName = (typeof TABLES)[number];

// Every computed line and finding cites the rows it came from.
export type SourceRef = { table: TableName; id: string };

// ---- Per-tenant pay configuration (`pay_configs`, one row per tenant) ----

export const PERCENT_BASES = ["linehaul", "linehaul_fsc", "linehaul_fsc_accessorials"] as const;
export type PercentBase = (typeof PERCENT_BASES)[number];
export const INSURANCE_APPLIES_TO = ["owner_operator", "all"] as const;
export type InsuranceAppliesTo = (typeof INSURANCE_APPLIES_TO)[number];

export type PayConfig = {
  // 0 is Sunday. Blue Ridge runs Monday to Sunday (1), Prairie Wind Sunday to Saturday (0).
  weekStartDow: number;
  percentBase: PercentBase;
  // Share of empty miles paid to per-mile drivers, 0 to 10000.
  emptyMilesPaidBps: number;
  // Share of payable accessorials (detention, layover, stop) paid to the driver, 0 to 10000.
  accessorialDriverShareBps: number;
  insuranceAppliesTo: InsuranceAppliesTo;
  insurancePerDayCents: Cents;
  // Tenant default; an escrow schedule's own target wins when it has one.
  escrowTargetCents: Cents;
  escrowPerSettlementCents: Cents;
  netPayFloorCents: Cents;
  // null means recover everything outstanding that the floor allows.
  advanceRecoveryCapCents: Cents | null;
  advanceFeeCents: Cents;
  // Tenant default; a driver's own limit wins when it has one.
  advanceLimitDefaultCents: Cents;
  advanceMaxBpsOfEarned: number;
  advanceMinCents: Cents;
};

// ---- Operations (migration 0003) ----

export const WORKER_TYPES = ["company", "owner_operator"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];
export const PAY_BASES = ["per_mile", "percent", "flat"] as const;
export type PayBasis = (typeof PAY_BASES)[number];
export const LOAD_STATUSES = [
  "planned",
  "in_transit",
  "delivered",
  "invoiced",
  "cancelled",
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];
export const ACCESSORIAL_KINDS = ["detention", "layover", "stop", "lumper"] as const;
export type AccessorialKind = (typeof ACCESSORIAL_KINDS)[number];
export const DAY_SOURCES = ["load", "dispatch"] as const;
export type DaySource = (typeof DAY_SOURCES)[number];
export const FUEL_PAID_WITH = ["company_card", "driver_own"] as const;
export type FuelPaidWith = (typeof FUEL_PAID_WITH)[number];

export type CustomerRecord = {
  id: string;
  code: string;
  name: string;
  termsDays: number;
  city: string;
  state: string;
};

export type DriverRecord = {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
  email: string;
  workerType: WorkerType;
  payBasis: PayBasis;
  // Exactly the one matching payBasis is set; the engine reads only that one.
  perMileCents: Cents | null;
  percentBps: number | null;
  flatPerLoadCents: Cents | null;
  // null means the tenant's advanceLimitDefaultCents.
  advanceLimitCents: Cents | null;
  escrowBalanceCents: Cents;
  truckUnit: string | null;
  activeFrom: LocalDate;
  activeTo: LocalDate | null;
};

// One row per state a load crossed, whole miles. For every load the miles sum to
// loadedMiles + emptyMiles (assertStateMiles).
export type StateMilesRecord = { id: string; state: string; miles: number };

export type AccessorialRecord = {
  id: string;
  kind: AccessorialKind;
  seq: number;
  amountCents: Cents;
  // Lumper only: the driver paid it and is owed a reimbursement.
  paidByDriver: boolean;
  description: string | null;
};

export type LoadRecord = {
  id: string;
  loadNumber: string;
  customerId: string | null;
  driverId: string | null;
  status: LoadStatus;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  pickupOn: LocalDate;
  // Set when delivered or invoiced, in the tenant's zone. Pay math reads only this date.
  deliveredOn: LocalDate | null;
  deliveredAt: Instant | null;
  loadedMiles: number;
  emptyMiles: number;
  // null is the planted "delivered with no rate" problem, never zero.
  linehaulCents: Cents | null;
  fuelSurchargeCents: Cents;
  stateMiles: StateMilesRecord[];
  accessorials: AccessorialRecord[];
};

// One row per driver per day worked; the unique key is the "one charge per day" rule.
export type DriverDayRecord = {
  id: string;
  driverId: string;
  day: LocalDate;
  source: DaySource;
  loadId: string | null;
};

export type FuelPurchaseRecord = {
  id: string;
  driverId: string;
  loadId: string | null;
  purchasedAt: Instant;
  purchasedOn: LocalDate;
  state: string;
  // Thousandths of a gallon.
  gallonsMilli: number;
  amountCents: Cents;
  paidWith: FuelPaidWith;
  purchaseRef: string;
};

// ---- Pay (migration 0004) ----

export const PAY_ITEM_KINDS = [
  "fuel",
  "reimbursement",
  "other_deduction",
  "carried_shortfall",
] as const;
export type PayItemKind = (typeof PAY_ITEM_KINDS)[number];
export const SCHEDULE_KINDS = ["escrow", "lease", "other"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const ADVANCE_STATUSES = ["requested", "approved", "paid", "rejected", "cancelled"] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];
export const ADVANCE_SOURCES = ["ui", "email", "seed"] as const;
export type AdvanceSource = (typeof ADVANCE_SOURCES)[number];
export const PERIOD_STATUSES = ["open", "approved", "paid"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const SETTLEMENT_STATUSES = ["draft", "approved", "paid"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
// Section 4.8: the stored status follows the payments applied to the invoice.
export const INVOICE_STATUSES = ["open", "partially_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
// `opening` invoices are AR history with no load behind them.
export const INVOICE_SOURCES = ["load", "opening"] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

export type ScheduleRecord = {
  id: string;
  driverId: string;
  kind: ScheduleKind;
  // Taken once per settlement while active.
  amountCents: Cents;
  // Escrow only; null means the tenant's escrowTargetCents.
  targetCents: Cents | null;
  description: string | null;
  activeFrom: LocalDate;
  activeTo: LocalDate | null;
};

export type PayItemRecord = {
  id: string;
  driverId: string;
  // The kind gives the sign: reimbursement adds, the others deduct.
  kind: PayItemKind;
  subkind: string | null;
  amountCents: Cents;
  itemDate: LocalDate;
  // What the item is for: a fuel item names its fuel_purchases row, a lumper reimbursement its
  // load_accessorials row.
  refTable: TableName | null;
  refId: string | null;
  itemRef: string;
  description: string | null;
  settlementId: string | null;
};

export type AdvanceRecord = {
  id: string;
  driverId: string;
  requestRef: string;
  requestedAt: Instant;
  requestedOn: LocalDate;
  amountCents: Cents;
  feeCents: Cents;
  status: AdvanceStatus;
  // Taken back so far; what is left of amount + fee is outstanding.
  recoveredCents: Cents;
  source: AdvanceSource;
  reasonCategory: string | null;
  paidAt: Instant | null;
};

export type SettlementPeriodRecord = {
  id: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  status: PeriodStatus;
};

export type SettlementRecord = {
  id: string;
  periodId: string;
  driverId: string;
  status: SettlementStatus;
  grossCents: Cents;
  deductionsCents: Cents;
  netCents: Cents;
  carryForwardCents: Cents;
  exceptionCount: number;
  paidAt: Instant | null;
};

export type InvoiceRecord = {
  id: string;
  source: InvoiceSource;
  // Null only when source is `opening`.
  loadId: string | null;
  customerId: string;
  invoiceNumber: string;
  amountCents: Cents;
  issuedOn: LocalDate;
  dueOn: LocalDate;
  status: InvoiceStatus;
  paidOn: LocalDate | null;
  qboId: string | null;
};

// ---- Settlement: one driver, one period ----

export const LINE_KINDS = [
  "load_pay",
  "accessorial_pay",
  "reimbursement",
  "fuel",
  "other_deduction",
  "carried_shortfall",
  "lease",
  "insurance",
  "escrow",
  "advance_recovery",
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

// Numbers and short codes only (rates, miles, bases), stored as jsonb next to the line.
export type PayLineMeta = Record<string, string | number | boolean | null>;

export type PayLine = {
  seq: number;
  kind: LineKind;
  label: string;
  // Signed: earnings positive, deductions negative.
  amountCents: Cents;
  sources: SourceRef[];
  meta?: PayLineMeta;
};

// A stored settlement line (`settlement_lines`).
export type SettlementLineRecord = PayLine & { id: string; settlementId: string };

export const EXCEPTION_CATEGORIES = ["load_rate_missing", "net_below_zero"] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

// Something a person must look at before the settlement is approved. `kind` is where on the
// paystub it sits, `category` is why.
export type ExceptionLine = {
  kind: "load_pay" | "net";
  category: ExceptionCategory;
  sources: SourceRef[];
  amountCents?: Cents;
};

export const NOTE_CATEGORIES = ["at_target", "floor", "cap"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

// Why a discretionary deduction took less than scheduled or outstanding: the escrow reached its
// target, the net pay floor stopped it, or the tenant's recovery cap did. `amountCents` is what
// was not taken.
export type SettlementNote = {
  kind: "escrow" | "advance_recovery";
  category: NoteCategory;
  sources: SourceRef[];
  amountCents: Cents;
};

export type SettlementInput = {
  config: PayConfig;
  driver: DriverRecord;
  period: Period;
  // The driver's records; the engine picks those dated in the period.
  loads: LoadRecord[];
  days: DriverDayRecord[];
  items: PayItemRecord[];
  schedules: ScheduleRecord[];
  advances: AdvanceRecord[];
  // The escrow balance before this settlement.
  escrowBalanceCents: Cents;
};

export type SettlementResult = {
  lines: PayLine[];
  exceptions: ExceptionLine[];
  notes: SettlementNote[];
  grossCents: Cents;
  // Every deduction line, as a positive number.
  deductionsCents: Cents;
  // Never below zero: netCents = grossCents - deductionsCents + carryForwardCents.
  netCents: Cents;
  // What the hard deductions took past gross; next period's carried_shortfall item.
  carryForwardCents: Cents;
  recoveries: { advanceId: string; cents: Cents }[];
  // Added to the driver's escrow balance.
  escrowDeltaCents: Cents;
  insuredDays: number;
};

// ---- Advances ----

export const ADVANCE_REFUSALS = [
  "driver_inactive",
  "below_minimum",
  "no_unpaid_earnings",
  "over_driver_limit",
  "exceeds_earned_share",
  "possible_duplicate",
] as const;
export type AdvanceRefusal = (typeof ADVANCE_REFUSALS)[number];

export type AdvanceInput = {
  config: PayConfig;
  driver: DriverRecord;
  amountCents: Cents;
  requestedAt: Instant;
  // requestedAt as a date in the tenant's zone.
  requestedOn: LocalDate;
  // The driver's loads; those delivered inside a paid period are already paid.
  loads: LoadRecord[];
  paidPeriods: Period[];
  // The driver's advances, any status.
  advances: AdvanceRecord[];
};

export type AdvanceDecision = {
  eligible: boolean;
  approvedCents: Cents;
  // The most this driver could get now, so the agent can propose a smaller amount.
  maxCents: Cents;
  feeCents: Cents;
  reasons: AdvanceRefusal[];
  earnedUnpaidCents: Cents;
  openCents: Cents;
  limitCents: Cents;
  sources: SourceRef[];
};

// ---- Invoices ----

export type InvoiceLine = {
  kind: "linehaul" | "fuel_surcharge" | AccessorialKind;
  amountCents: Cents;
  sources: SourceRef[];
};

export type InvoiceResult =
  | { ok: true; amountCents: Cents; lines: InvoiceLine[]; sources: SourceRef[] }
  | {
      ok: false;
      reason: "missing_rate" | "missing_customer" | "not_delivered";
      sources: SourceRef[];
    };

// ---- The six checks ----

export const CHECK_NAMES = [
  "duplicate_advance",
  "fuel_on_wrong_driver",
  "insurance_day_not_driven",
  "missing_reimbursement",
  "delivered_without_rate",
  "over_advance_limit",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export const FINDING_CATEGORIES = [
  "newer_is_duplicate",
  "purchase_on_other_driver",
  "load_on_other_driver",
  "purchase_not_found",
  "no_load_that_day",
  "no_reimbursement",
  "rate_missing",
  "over_limit",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

// Categories and ids only, never prose from the data. sources[0] is the record at fault (the
// newer advance, the fuel item, the day row, the accessorial, the load, the driver).
export type Finding = {
  check: CheckName;
  category: FindingCategory;
  driverId?: string;
  amountCents?: Cents;
  sources: SourceRef[];
};

// Everything one tenant holds that the six checks read.
export type CheckInput = {
  config: PayConfig;
  drivers: DriverRecord[];
  loads: LoadRecord[];
  days: DriverDayRecord[];
  fuelPurchases: FuelPurchaseRecord[];
  items: PayItemRecord[];
  advances: AdvanceRecord[];
};
