import { z } from "zod";
import { flags } from "../../../../../config/flags";
import {
  detentionChargeOf,
  type DetentionChargeRefusal,
  type DetentionChargeRows,
} from "../../../../data/detention-charge";
import { readTable } from "../../../../data/read";
import { customerOf, loadStopsOf } from "../../../../data/records";
import { findUnbilledDetention, lastFullMonthBefore, sum } from "../../../../rules-engine";
import { addDays, localDateOf, type Period } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// Detention the carrier earned and never billed, for one month of delivered loads. The engine's
// findUnbilledDetention does the finding and the math; this tool reads the rows, picks the month
// (the carrier's last full month unless one is named) and says, per load, whether the charge can
// go on the load's invoice with the same check the propose tool's limit and the executor use.

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;

// The calendar month of "YYYY-MM", first to last day.
export function monthPeriod(month: string): Period {
  if (!MONTH.test(month)) throw new RangeError("not a month");
  const [year, m] = month.split("-").map(Number);
  const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: `${month}-01`, end: addDays(next, -1) };
}

// Why a found load's charge cannot go on its invoice, in the words the model is given.
const BLOCKED: Readonly<Record<DetentionChargeRefusal, string>> = {
  no_detention: "no_detention",
  already_billed: "already_billed",
  no_invoice: "no_invoice",
  invoice_posted: "invoice_posted",
  invoice_mismatch: "invoice_total_differs",
};

// Null when the charge can be proposed for exactly the cents found; otherwise the reason. A read
// or engine error is unknown, never a yes.
function blockedFor(rows: DetentionChargeRows | null, amountCents: number): string | null {
  if (!rows) return "unknown";
  try {
    const check = detentionChargeOf(rows);
    if (!check.ok) return BLOCKED[check.reason];
    return check.charge.amountCents === amountCents ? null : "unknown";
  } catch {
    return "unknown";
  }
}

export const findUnbilledDetentionTool = defineTool({
  name: "find_unbilled_detention",
  description:
    "Find delivered loads whose stop times earned detention that was never billed, for one " +
    "month in the carrier's time zone (YYYY-MM; the last full month when left out). Each row " +
    "gives the engine's minutes at the stop, minutes over free time, started quarter hours and " +
    "cents per stop, the customer's terms, the load's invoice, and whether the charge can be " +
    "proposed onto that invoice. Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Looking for unbilled detention",
  enabled: () => flags.detentionEnabled,
  args: z.strictObject({
    month: z.string().regex(MONTH).optional(),
  }),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    if (!flags.detentionEnabled) throw new Error("detention is switched off");
    const window = a.month
      ? monthPeriod(a.month)
      : lastFullMonthBefore(localDateOf(ctx.now.toISOString(), ctx.timeZone));
    const loads = await readTable(q, "loads");
    const customers = await readTable(q, "customers");
    const accessorials = await readTable(q, "load_accessorials");
    const miles = await readTable(q, "load_state_miles");
    const invoices = await readTable(q, "invoices");
    const found = findUnbilledDetention(
      loads.map(loadStopsOf),
      customers.map(customerOf),
      accessorials.map((x) => ({ loadId: x.load_id, kind: x.kind })),
      window,
    );
    const loadById = new Map(loads.map((l) => [l.id, l]));
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const rows = found.map((f) => {
      const load = loadById.get(f.loadId);
      const customer = customerById.get(f.customerId);
      const invoice = invoices.find((i) => i.source === "load" && i.load_id === f.loadId) ?? null;
      const blockedBy = blockedFor(
        load && customer
          ? {
              load,
              customer,
              miles: miles.filter((m) => m.load_id === f.loadId),
              accessorials: accessorials.filter((x) => x.load_id === f.loadId),
              invoices: invoices.filter((i) => i.load_id === f.loadId),
            }
          : null,
        f.amountCents,
      );
      return {
        loadId: f.loadId,
        loadNumber: f.loadNumber,
        customerId: f.customerId,
        customerName: customer?.name ?? null,
        deliveredOn: f.deliveredOn,
        freeMinutes: customer?.detention_free_minutes ?? null,
        hourlyCents: customer?.detention_hourly_cents ?? null,
        stops: f.stops.map((s) => ({
          stop: s.stop,
          dwellMinutes: s.dwellMinutes,
          overMinutes: s.overMinutes,
          quarters: s.quarters,
          cents: s.cents,
        })),
        amountCents: f.amountCents,
        invoiceId: invoice?.id ?? null,
        invoiceNumber: invoice?.invoice_number ?? null,
        invoiceStatus: invoice?.status ?? null,
        invoiceAmountCents: invoice?.amount_cents ?? null,
        postedToAccounting: invoice ? invoice.qbo_id !== null : false,
        canPropose: blockedBy === null,
        blockedBy,
      };
    });
    return {
      result: {
        window,
        rows,
        count: rows.length,
        totalCents: sum(found.map((f) => f.amountCents)),
        note: "Each charge needs propose_detention_charge with the row's amountCents and a person's approval.",
      },
    };
  },
});
