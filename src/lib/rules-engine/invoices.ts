import { checkLoad, isDelivered } from "./load-pay";
import { assertCents, sum } from "./money";
import { compareText, type InvoiceLine, type InvoiceResult, type LoadRecord } from "./types";

// What the customer owes for one load: linehaul + fuel surcharge + every accessorial (lumper
// included; the customer pays it even when the driver fronted it). A load that is not delivered,
// has no rate, or has no customer is refused with the reason, never invoiced at a guess.
export function invoiceAmount(load: LoadRecord): InvoiceResult {
  checkLoad(load);
  const sources = [{ table: "loads" as const, id: load.id }];
  if (!isDelivered(load)) return { ok: false, reason: "not_delivered", sources };
  if (load.linehaulCents === null) return { ok: false, reason: "missing_rate", sources };
  if (load.customerId === null) return { ok: false, reason: "missing_customer", sources };
  const lines: InvoiceLine[] = [{ kind: "linehaul", amountCents: load.linehaulCents, sources }];
  if (load.fuelSurchargeCents > 0) {
    lines.push({ kind: "fuel_surcharge", amountCents: load.fuelSurchargeCents, sources });
  }
  const accessorials = [...load.accessorials].sort(
    (a, b) => compareText(a.kind, b.kind) || a.seq - b.seq || compareText(a.id, b.id),
  );
  for (const a of accessorials) {
    if (a.amountCents === 0) continue;
    lines.push({
      kind: a.kind,
      amountCents: a.amountCents,
      sources: [{ table: "load_accessorials", id: a.id }],
    });
  }
  // The invoices table holds under 10^9 cents; a total past that is refused, not truncated.
  const amountCents = assertCents(sum(lines.map((l) => l.amountCents)), `load ${load.id} invoice`);
  return { ok: true, amountCents, lines, sources };
}
