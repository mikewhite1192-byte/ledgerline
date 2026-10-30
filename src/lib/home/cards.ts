import type { InvoiceListRow } from "@/lib/invoices/views";
import type { PeriodOption, SettlementListRow } from "@/lib/settlements/views";

// What Home's payday and owed cards show, counted from the rows the Settlements and Invoices pages
// already read. Nothing here computes pay; it only counts and adds stored integer cents.

export type Payday = {
  period: PeriodOption | null;
  paystubs: number;
  // Cards waiting for a person's approval.
  waiting: number;
  approved: number;
  paid: number;
  held: number;
  problems: number;
  netCents: number;
};

export function paydayOf(view: { period: PeriodOption | null; rows: readonly SettlementListRow[] }): Payday {
  const { rows } = view;
  return {
    period: view.period,
    paystubs: rows.length,
    waiting: rows.filter((r) => r.proposalStatus === "proposed").length,
    approved: rows.filter((r) => r.status === "approved").length,
    paid: rows.filter((r) => r.status === "paid").length,
    held: rows.filter((r) => r.parkedReason !== null).length,
    problems: rows.filter((r) => r.exceptionCount > 0).length,
    netCents: rows.reduce((s, r) => s + r.netCents, 0),
  };
}

export type Owed = { invoices: number; owedCents: number; late: number; lateCents: number };

// Open balances, and the part past its due date as of the carrier's today (the same test as the
// past-due row in Needs you).
export function owedOf(rows: readonly InvoiceListRow[]): Owed {
  const open = rows.filter((r) => r.balanceCents > 0);
  const late = open.filter((r) => r.bucket !== null && r.bucket !== "current");
  return {
    invoices: open.length,
    owedCents: open.reduce((s, r) => s + r.balanceCents, 0),
    late: late.length,
    lateCents: late.reduce((s, r) => s + r.balanceCents, 0),
  };
}
