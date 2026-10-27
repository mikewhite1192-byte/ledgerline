import type { Queryable } from "../db";
import { invoiceStatus } from "../rules-engine";

// An invoice's stored status and paid date, recomputed from its applications by the rules engine,
// inside the caller's transaction (the invoice row already locked). A paid invoice was paid on the
// latest received date of the payments applied to it, never earlier than the day it was issued
// (the table's own check). A void invoice is left alone.
export async function refreshInvoiceStatus(q: Queryable, invoiceId: string): Promise<void> {
  const [row] = await q.query<{
    amount_cents: number | string;
    status: string;
    issued_on: string;
    applied: number | string | null;
    last_received: string | null;
  }>(
    `SELECT i.amount_cents, i.status, CAST(i.issued_on AS text) AS issued_on,
            (SELECT sum(a.amount_cents) FROM payment_applications a
              WHERE a.tenant_id = current_tenant_id() AND a.invoice_id = i.id) AS applied,
            (SELECT CAST(max(p.received_on) AS text) FROM payment_applications a
               JOIN customer_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = current_tenant_id() AND a.invoice_id = i.id) AS last_received
       FROM invoices i
      WHERE i.tenant_id = current_tenant_id() AND i.id = CAST($1 AS uuid)`,
    [invoiceId],
  );
  if (!row) throw new Error("invoice not found");
  if (row.status === "void") return;
  const { status } = invoiceStatus(Number(row.amount_cents), Number(row.applied ?? 0));
  const paidOn =
    status === "paid" && row.last_received
      ? row.last_received > row.issued_on
        ? row.last_received
        : row.issued_on
      : null;
  await q.execute(
    `UPDATE invoices SET status = $2, paid_on = CAST($3 AS date)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status <> 'void'`,
    [invoiceId, status, paidOn],
  );
}
