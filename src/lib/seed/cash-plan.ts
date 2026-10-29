import { cashFridayInputOf } from "../data/records";
import type { CashSettingsRow, TenantRows, VendorBillRow } from "../data/rows";
import { computeCashFriday, payDayFor, type CashFridayLimits, type CashPosition } from "../rules-engine";
import { addDays, type LocalDate, type Period } from "../time/local-date";
import type { DemoCarrier } from "./carriers";
import { Rng } from "./prng";

// Cash Friday's seeded rows for one carrier (design 4.9): the bank position and factoring terms,
// and six bills from invented vendors. Everything comes from its own id stream, so no other row of
// the plan changes. The bank balance is planted last: the engine computes the carrier's position
// at the anchor with a zero balance, and the balance is then set so the gap is exactly the planted
// one (Blue Ridge short by $6,800.00, Prairie Wind covered with $2,140.00 to spare).

export const PLANTED_GAP_CENTS: Record<DemoCarrier["slug"], number> = {
  "blue-ridge": -680_000,
  "prairie-wind": 214_000,
};

// A copy of a demo carrier under another slug (some database tests seed one) has no planted gap:
// its balance covers Friday exactly.
export function plantedGapCents(slug: string): number {
  const planted: Readonly<Record<string, number>> = PLANTED_GAP_CENTS;
  return Object.hasOwn(planted, slug) ? planted[slug] : 0;
}

export const PAY_DAY_DOW = 5;
export const FACTORING_ADVANCE_BPS = 9000;
export const FACTORING_FEE_BPS = 300;

type BillDraft = {
  vendor: string;
  code: string;
  category: VendorBillRow["category"];
  urgency: VendorBillRow["urgency"];
  // Days from pay day to the due date (negative is before pay day).
  dueFromPayDay: number;
  // Cents, both included.
  amount: readonly [number, number];
  // Paid this many days after it was due; null leaves it open.
  paidAfterDays: number | null;
};

// Sized for a fleet of about twenty-five trucks: the week's fuel and the month's insurance are
// fixed and due before pay day, two flexible bills are due before pay day (the "delay a bill"
// option picks the larger, the shop's), the lease is due after it (not counted), and a toll bill
// is already paid.
const BILLS: readonly BillDraft[] = [
  {
    vendor: "Granite State Fuel Supply",
    code: "GSF",
    category: "fuel_supplier",
    urgency: "fixed",
    dueFromPayDay: -2,
    amount: [3_800_000, 4_600_000],
    paidAfterDays: null,
  },
  {
    vendor: "Summit Fleet Insurance",
    code: "SFI",
    category: "insurance",
    urgency: "fixed",
    dueFromPayDay: -1,
    amount: [2_600_000, 3_200_000],
    paidAfterDays: null,
  },
  {
    vendor: "Northline Tire and Brake",
    code: "NTB",
    category: "maintenance",
    urgency: "flexible",
    dueFromPayDay: -1,
    amount: [840_000, 1_160_000],
    paidAfterDays: null,
  },
  {
    vendor: "Clearway Fleet Software",
    code: "CFS",
    category: "software",
    urgency: "flexible",
    dueFromPayDay: -3,
    amount: [120_000, 180_000],
    paidAfterDays: null,
  },
  {
    vendor: "Ridgeline Truck Leasing",
    code: "RTL",
    category: "lease",
    urgency: "fixed",
    dueFromPayDay: 4,
    amount: [2_800_000, 3_400_000],
    paidAfterDays: null,
  },
  {
    vendor: "Open Road Tolls",
    code: "ORT",
    category: "tolls",
    urgency: "fixed",
    dueFromPayDay: -12,
    amount: [180_000, 260_000],
    paidAfterDays: 1,
  },
];

export type CashRows = Pick<TenantRows, "vendor_bills" | "cash_settings">;

export function buildCashRows(args: {
  carrier: DemoCarrier;
  anchor: LocalDate;
  openWeek: Period;
  rows: TenantRows;
  limits: CashFridayLimits;
}): CashRows {
  const { carrier, anchor, openWeek, rows, limits } = args;
  const rng = new Rng(`${carrier.slug}:${anchor}:cash`);
  const newId = () => rng.uuid();
  const payDay = payDayFor(openWeek, PAY_DAY_DOW, anchor);

  const bills: VendorBillRow[] = BILLS.map((b) => {
    const dueOn = addDays(payDay, b.dueFromPayDay);
    const paidOn = b.paidAfterDays === null ? null : addDays(dueOn, b.paidAfterDays);
    if (paidOn !== null && paidOn > addDays(anchor, -1)) throw new Error("a seeded bill is paid after the anchor");
    return {
      id: newId(),
      bill_ref: `${carrier.prefix}-${b.code}-${rng.int(1000, 9999)}`,
      vendor_name: b.vendor,
      category: b.category,
      amount_cents: rng.int(b.amount[0], b.amount[1]),
      due_on: dueOn,
      urgency: b.urgency,
      status: paidOn === null ? "open" : "paid",
      deferred_to: null,
      paid_on: paidOn,
      proposal_id: null,
    };
  });

  const settings: CashSettingsRow = {
    id: newId(),
    bank_balance_cents: 0,
    balance_as_of: addDays(anchor, -1),
    pay_day_dow: PAY_DAY_DOW,
    factoring_advance_bps: FACTORING_ADVANCE_BPS,
    factoring_fee_bps: FACTORING_FEE_BPS,
  };
  const zero = cashPositionOf({ ...rows, vendor_bills: bills, cash_settings: [settings] }, carrier, anchor, limits);
  settings.bank_balance_cents = plantedGapCents(carrier.slug) - zero.figures.gapCents;
  return { vendor_bills: bills, cash_settings: [settings] };
}

// The carrier's position at the anchor, as the Cash page computes it. A refusal is a broken plan.
export function cashPositionOf(
  rows: TenantRows,
  carrier: DemoCarrier,
  anchor: LocalDate,
  limits: CashFridayLimits,
): CashPosition {
  const result = computeCashFriday(cashFridayInputOf(rows, carrier.timezone, limits), anchor);
  if (!result.ok) throw new Error(`seed plan: cash friday refused (${result.refusal})`);
  return result;
}
