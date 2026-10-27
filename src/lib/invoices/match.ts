import type { Finding } from "../rules-engine";

// The one finding a payment move may act on: a payment_on_wrong_invoice finding whose sources are
// exactly [the payment, its application, the invoice it is on, the invoice it was meant for], in
// that order, compared whole. Agent tools import this file, so it imports only engine types.

export type ReapplyIds = {
  paymentId: string;
  applicationId: string;
  fromInvoiceId: string;
  toInvoiceId: string;
};

export function matchWrongInvoiceFinding(
  findings: readonly Finding[],
  ids: ReapplyIds,
): Finding | null {
  const want = [
    { table: "customer_payments", id: ids.paymentId },
    { table: "payment_applications", id: ids.applicationId },
    { table: "invoices", id: ids.fromInvoiceId },
    { table: "invoices", id: ids.toInvoiceId },
  ];
  return (
    findings.find(
      (f) =>
        f.check === "payment_on_wrong_invoice" &&
        f.category === "payment_on_wrong_invoice" &&
        typeof f.amountCents === "number" &&
        f.sources.length === want.length &&
        f.sources.every((s, i) => s.table === want[i].table && s.id === want[i].id),
    ) ?? null
  );
}
