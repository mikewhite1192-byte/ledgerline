import {
  compareText,
  invoiceAmount,
  type CustomerRecord,
  type InvoiceLine,
  type LoadRecord,
  type SourceRef,
} from "../rules-engine";
import type { QueueReason } from "./labels";

// The invoice queue, split by the rules engine: each delivered load with no invoice is either
// invoiceable (the engine's total and lines) or an exception (the engine's reason). Pure: the
// rows come from readInvoiceQueue (src/lib/data/read.ts). Agent tools import this file, so it
// imports nothing but the rules engine.

export type InvoiceableLoad = {
  load: LoadRecord;
  customer: CustomerRecord | null;
  amountCents: number;
  lines: InvoiceLine[];
  sources: SourceRef[];
};

export type QueueException = { load: LoadRecord; reason: QueueReason; sources: SourceRef[] };

export type InvoiceQueue = { invoiceable: InvoiceableLoad[]; exceptions: QueueException[] };

export function splitInvoiceQueue(
  loads: readonly LoadRecord[],
  customers: readonly CustomerRecord[],
): InvoiceQueue {
  const byId = new Map(customers.map((c) => [c.id, c]));
  const ordered = [...loads].sort(
    (a, b) => compareText(a.loadNumber, b.loadNumber) || compareText(a.id, b.id),
  );
  const out: InvoiceQueue = { invoiceable: [], exceptions: [] };
  for (const load of ordered) {
    const customer = load.customerId ? (byId.get(load.customerId) ?? null) : null;
    const result = invoiceAmount(load);
    if (!result.ok) {
      out.exceptions.push({ load, reason: result.reason, sources: result.sources });
    } else if (!customer) {
      // A customer id that names no customer row is as good as none.
      out.exceptions.push({
        load,
        reason: "missing_customer",
        sources: [{ table: "loads", id: load.id }],
      });
    } else {
      out.invoiceable.push({
        load,
        customer,
        amountCents: result.amountCents,
        lines: result.lines,
        sources: result.sources,
      });
    }
  }
  return out;
}

// What a proposal stores and the executor compares whole: the total and each line's kind and cents
// in the engine's order.
export type LineSummary = { kind: InvoiceLine["kind"]; amountCents: number };

export function lineSummary(lines: readonly InvoiceLine[]): LineSummary[] {
  return lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents }));
}

export function sameLines(a: readonly LineSummary[], b: readonly LineSummary[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.kind === b[i].kind && x.amountCents === b[i].amountCents)
  );
}
