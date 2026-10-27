import { z } from "zod";
import {
  cents,
  detentionStops,
  invoiceAmount,
  sum,
  type Cents,
  type SourceRef,
  type StopDetention,
} from "../rules-engine";
import type { Queryable } from "../db";
import { readRowsWhereId } from "./read";
import { customerOf, loadsOf, loadStopsOf } from "./records";
import type {
  CustomerRow,
  InvoiceRow,
  LoadAccessorialRow,
  LoadRow,
  LoadStateMilesRow,
} from "./rows";

// One load's unbilled detention as a charge on its invoice: what the agent's limit, the propose
// tool, the find tool and the approval's executor all check, from the same rows, with the same
// engine. The engine sizes every number (detentionStops for the stops, invoiceAmount for the
// invoice); this file only decides whether the charge can go on the invoice and says why not.
//
// A charge exists only when every one of these holds:
//   - both stops have their times (unknown is not zero) and at least one earns detention;
//   - the load carries no detention accessorial yet;
//   - the load has exactly one load invoice, still open and never posted to accounting;
//   - that invoice's amount equals the engine's total for the load today, so adding the
//     detention gives exactly the engine's total after.

export type DetentionChargeRows = {
  load: LoadRow;
  customer: CustomerRow;
  miles: readonly LoadStateMilesRow[];
  accessorials: readonly LoadAccessorialRow[];
  // The load's invoices (the table allows one per load).
  invoices: readonly InvoiceRow[];
};

// One earning stop, with the two instants it was computed from.
export type ChargeStop = StopDetention & { arrivedAt: string; departedAt: string };

export type DetentionCharge = {
  loadId: string;
  loadNumber: string;
  customerId: string;
  invoiceId: string;
  invoiceAmountBeforeCents: Cents;
  invoiceAmountAfterCents: Cents;
  amountCents: Cents;
  freeMinutes: number;
  hourlyCents: Cents;
  stops: ChargeStop[];
  sources: SourceRef[];
};

// Why a load has no charge to add. Categories only; the executor maps them to its own words.
export type DetentionChargeRefusal =
  | "no_detention"
  | "already_billed"
  | "no_invoice"
  | "invoice_posted"
  | "invoice_mismatch";

export type DetentionChargeCheck =
  | { ok: true; charge: DetentionCharge }
  | { ok: false; reason: DetentionChargeRefusal };

function instantsOf(load: LoadRow, stop: StopDetention["stop"]): { arrivedAt: string; departedAt: string } {
  const arrivedAt = stop === "pickup" ? load.pickup_arrived_at : load.delivery_arrived_at;
  const departedAt = stop === "pickup" ? load.pickup_departed_at : load.delivery_departed_at;
  // detentionStops returned this stop, so both times are set.
  if (arrivedAt === null || departedAt === null) throw new Error("a stop with detention has no times");
  return { arrivedAt, departedAt };
}

// Throws the engine's InputError on malformed rows (a stop with one time, a departure before its
// arrival, a customer that is not the load's); every caller treats a throw as unknown.
export function detentionChargeOf(rows: DetentionChargeRows): DetentionChargeCheck {
  const { load, customer } = rows;
  const stops = detentionStops(loadStopsOf(load), customerOf(customer));
  const earning = (stops ?? []).filter((s) => s.cents > 0);
  if (earning.length === 0) return { ok: false, reason: "no_detention" };
  const own = rows.accessorials.filter((a) => a.load_id === load.id);
  if (own.some((a) => a.kind === "detention")) return { ok: false, reason: "already_billed" };
  const invoices = rows.invoices.filter((i) => i.source === "load" && i.load_id === load.id);
  if (invoices.length !== 1) return { ok: false, reason: "no_invoice" };
  const [invoice] = invoices;
  if (invoice.status !== "open" || invoice.qbo_id !== null) return { ok: false, reason: "invoice_posted" };
  const [record] = loadsOf([load], rows.miles, own);
  const before = invoiceAmount(record);
  if (!before.ok || before.amountCents !== invoice.amount_cents) {
    return { ok: false, reason: "invoice_mismatch" };
  }
  const amountCents = sum(earning.map((s) => s.cents));
  return {
    ok: true,
    charge: {
      loadId: load.id,
      loadNumber: load.load_number,
      customerId: customer.id,
      invoiceId: invoice.id,
      invoiceAmountBeforeCents: before.amountCents,
      invoiceAmountAfterCents: cents(before.amountCents + amountCents),
      amountCents,
      freeMinutes: customer.detention_free_minutes,
      hourlyCents: cents(customer.detention_hourly_cents),
      stops: earning.map((s) => ({ ...s, ...instantsOf(load, s.stop) })),
      sources: [
        { table: "loads", id: load.id },
        { table: "customers", id: customer.id },
        { table: "invoices", id: invoice.id },
      ],
    },
  };
}

// What a detention_charge proposal stores as its args: ids, cents, minutes, enums and the
// readers' UTC instants, never free text. The executor parses the stored args with this schema
// and compares every field with what the engine says at approval.
const CENTS = z.int().min(0).max(999_999_999);
const MINUTES = z.int().min(0).max(1_000_000);
const INSTANT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const chargeArgsSchema = z.strictObject({
  loadId: UUID,
  amountCents: CENTS.min(1),
  invoiceId: UUID,
  invoiceAmountBeforeCents: CENTS.min(1),
  freeMinutes: MINUTES,
  hourlyCents: CENTS,
  stops: z
    .array(
      z.strictObject({
        stop: z.enum(["pickup", "delivery"]),
        dwellMinutes: MINUTES,
        overMinutes: MINUTES,
        quarters: MINUTES,
        cents: CENTS,
        arrivedAt: INSTANT,
        departedAt: INSTANT,
      }),
    )
    .min(1)
    .max(2),
});
export type ChargeArgs = z.infer<typeof chargeArgsSchema>;

export function chargeArgsOf(charge: DetentionCharge): ChargeArgs {
  return {
    loadId: charge.loadId,
    amountCents: charge.amountCents,
    invoiceId: charge.invoiceId,
    invoiceAmountBeforeCents: charge.invoiceAmountBeforeCents,
    freeMinutes: charge.freeMinutes,
    hourlyCents: charge.hourlyCents,
    stops: charge.stops.map((s) => ({
      stop: s.stop,
      dwellMinutes: s.dwellMinutes,
      overMinutes: s.overMinutes,
      quarters: s.quarters,
      cents: s.cents,
      arrivedAt: s.arrivedAt,
      departedAt: s.departedAt,
    })),
  };
}

// The stored args say exactly what the engine says now: every id, cent, minute and instant.
export function chargeMatches(args: ChargeArgs, charge: DetentionCharge): boolean {
  return (
    args.loadId === charge.loadId &&
    args.amountCents === charge.amountCents &&
    args.invoiceId === charge.invoiceId &&
    args.invoiceAmountBeforeCents === charge.invoiceAmountBeforeCents &&
    args.freeMinutes === charge.freeMinutes &&
    args.hourlyCents === charge.hourlyCents &&
    sameStops(args.stops, charge.stops)
  );
}

// The rows for one load of the current tenant, or null when the load or its customer is not
// there. Read-only; the executor takes its row locks before it calls this.
export async function readDetentionChargeRows(
  q: Queryable,
  loadId: string,
): Promise<DetentionChargeRows | null> {
  const [load] = await readRowsWhereId(q, "loads", "id", loadId);
  if (!load) return null;
  const [customer] = await readRowsWhereId(q, "customers", "id", load.customer_id);
  if (!customer) return null;
  return {
    load,
    customer,
    miles: await readRowsWhereId(q, "load_state_miles", "load_id", loadId),
    accessorials: await readRowsWhereId(q, "load_accessorials", "load_id", loadId),
    invoices: await readRowsWhereId(q, "invoices", "load_id", loadId),
  };
}

// The same stops, field for field: what the executor compares against the proposal it approves.
type StopFields = Omit<ChargeStop, "cents"> & { cents: number };
export function sameStops(a: readonly StopFields[], b: readonly StopFields[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return (
      s.stop === t.stop &&
      s.dwellMinutes === t.dwellMinutes &&
      s.overMinutes === t.overMinutes &&
      s.quarters === t.quarters &&
      s.cents === t.cents &&
      s.arrivedAt === t.arrivedAt &&
      s.departedAt === t.departedAt
    );
  });
}

// The accessorial's description: fixed words, the stops and the minutes over free time.
export function detentionDescription(stops: readonly StopDetention[]): string {
  const places = stops.map((s) => (s.stop === "pickup" ? "shipper" : "consignee")).join(" and ");
  const over = stops.reduce((n, s) => n + s.overMinutes, 0);
  return `Detention at ${places}, ${Math.floor(over / 60)} h ${over % 60} min over free time`;
}
