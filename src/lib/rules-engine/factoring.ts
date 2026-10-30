import { daysBetween, type LocalDate } from "../time/local-date";
import { cents, mulBps, sub, sum } from "./money";
import { invoiceStatus } from "./receivables";
import {
  assertDate,
  compareText,
  type Cents,
  type FactoringLine,
  type FactoringOption,
  type InvoiceRecord,
  type PaymentApplicationRecord,
  type SettlementPeriodRecord,
  type SourceRef,
} from "./types";

// Factoring (design docs/design-parity-money.md, 3.2): one invoice sold to the factoring partner
// for an advance now. Per invoice, in integer cents, from the carrier's cash settings:
//   advance = balance x advance rate    fee = balance x fee rate
//   net     = advance - fee             reserve = balance - advance
// Cash Friday's factoring option, the agent's propose_factoring and the approval's recompute all
// take these numbers from here, so the card, the second check and the partner see the same cents.
// No clock and no I/O: dates are tenant-local, converted by the caller.

export type FactoringRates = { factoringAdvanceBps: number; factoringFeeBps: number };

// One invoice's numbers at the carrier's rates.
export function factoringLineOf(
  invoice: Pick<InvoiceRecord, "id" | "invoiceNumber" | "customerId">,
  balanceCents: Cents,
  rates: FactoringRates,
): FactoringLine {
  const advanceCents = mulBps(balanceCents, rates.factoringAdvanceBps);
  const feeCents = mulBps(balanceCents, rates.factoringFeeBps);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    balanceCents,
    advanceCents,
    feeCents,
    netCents: sub(advanceCents, feeCents),
    reserveCents: sub(balanceCents, advanceCents),
  };
}

// The largest balance first, then the invoice number, then the id: one order everywhere.
export function compareFactoringLines(a: FactoringLine, b: FactoringLine): number {
  return (
    b.balanceCents - a.balanceCents ||
    compareText(a.invoiceNumber, b.invoiceNumber) ||
    compareText(a.invoiceId, b.invoiceId)
  );
}

// The card for these lines on the open week: the totals are the sums of the lines' own cents.
export function factoringOptionOf(
  lines: readonly FactoringLine[],
  rates: FactoringRates,
  period: Pick<SettlementPeriodRecord, "id">,
  shortCents: number,
): FactoringOption {
  const net = sum(lines.map((l) => l.netCents));
  return {
    kind: "factoring_request",
    subjectTable: "settlement_periods",
    subjectId: period.id,
    direction: "in",
    amountCents: net,
    advanceBps: rates.factoringAdvanceBps,
    feeBps: rates.factoringFeeBps,
    invoices: [...lines],
    balanceCents: sum(lines.map((l) => l.balanceCents)),
    advanceCents: sum(lines.map((l) => l.advanceCents)),
    feeCents: sum(lines.map((l) => l.feeCents)),
    reserveCents: sum(lines.map((l) => l.reserveCents)),
    coversShort: net >= shortCents,
    sources: [
      { table: "settlement_periods", id: period.id },
      ...lines.flatMap((l): SourceRef[] => [
        { table: "invoices", id: l.invoiceId },
        { table: "customers", id: l.customerId },
      ]),
    ],
  };
}

// Why an invoice cannot be factored now, first match wins. Fixed words; the card and the agent say
// them in plain sentences.
export const FACTORING_REFUSALS = [
  "no_invoices",
  "too_many_invoices",
  "duplicate_invoice",
  "rates_missing",
  "invoice_not_found",
  "invoice_not_from_load",
  "invoice_not_open",
  "invoice_already_factored",
  "invoice_no_balance",
  "invoice_too_old",
  "no_net",
] as const;
export type FactoringRefusal = (typeof FACTORING_REFUSALS)[number];

export type FactoringInput = {
  invoices: readonly InvoiceRecord[];
  applications: readonly PaymentApplicationRecord[];
  rates: FactoringRates | null;
  period: Pick<SettlementPeriodRecord, "id">;
};

export type FactoringDecision =
  | { ok: true; option: FactoringOption }
  | { ok: false; category: FactoringRefusal; invoiceId: string | null };

// Exactly these invoices, each one checked: a load's invoice, open or partly paid, not already on a
// live factoring line, owing money, and issued no more than maxAgeDays before asOf (and not after
// it). Whether the customer is expected by pay day does not matter here: that only decides which
// invoices Cash Friday suggests, never which ones may be sold.
export function factoringFor(
  input: FactoringInput,
  invoiceIds: readonly string[],
  asOfDate: LocalDate,
  limits: { maxAgeDays: number; maxInvoices: number },
  shortCents: number,
): FactoringDecision {
  const asOf = assertDate(asOfDate, "asOf");
  const no = (category: FactoringRefusal, invoiceId: string | null = null): FactoringDecision => ({
    ok: false,
    category,
    invoiceId,
  });
  if (invoiceIds.length === 0) return no("no_invoices");
  if (invoiceIds.length > limits.maxInvoices) return no("too_many_invoices");
  if (new Set(invoiceIds).size !== invoiceIds.length) return no("duplicate_invoice");
  const rates = input.rates;
  if (!rates) return no("rates_missing");

  const byId = new Map(input.invoices.map((i) => [i.id, i]));
  const applied = new Map<string, number>();
  for (const a of input.applications) applied.set(a.invoiceId, sum([applied.get(a.invoiceId) ?? 0, a.amountCents]));

  const lines: FactoringLine[] = [];
  for (const id of invoiceIds) {
    const invoice = byId.get(id);
    if (!invoice) return no("invoice_not_found", id);
    if (invoice.source !== "load") return no("invoice_not_from_load", id);
    if (invoice.status !== "open" && invoice.status !== "partially_paid") return no("invoice_not_open", id);
    if (invoice.factored === true) return no("invoice_already_factored", id);
    const { balanceCents } = invoiceStatus(invoice.amountCents, applied.get(id) ?? 0);
    if (balanceCents <= 0) return no("invoice_no_balance", id);
    const age = daysBetween(invoice.issuedOn, asOf);
    if (age < 0 || age > limits.maxAgeDays) return no("invoice_too_old", id);
    lines.push(factoringLineOf(invoice, cents(balanceCents), rates));
  }
  lines.sort(compareFactoringLines);
  if (lines.some((l) => l.netCents <= 0)) return no("no_net");
  return { ok: true, option: factoringOptionOf(lines, rates, input.period, shortCents) };
}
