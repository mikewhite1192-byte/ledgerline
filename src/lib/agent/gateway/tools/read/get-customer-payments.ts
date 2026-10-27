import { z } from "zod";
import { readRowsWhereId, readTable } from "../../../../data/read";
import { compareText } from "../../../../rules-engine";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getCustomerPayments = defineTool({
  name: "get_customer_payments",
  description:
    "List customer payments, newest first, optionally for one customer, each with the invoices " +
    "it was applied to. Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading customer payments",
  args: z.strictObject({ customerId: idField().optional() }),
  refs: (a): GatewayRef[] => (a.customerId ? [{ table: "customers", id: a.customerId }] : []),
  run: async (q, _ctx, a) => {
    const payments = a.customerId
      ? await readRowsWhereId(q, "customer_payments", "customer_id", a.customerId)
      : await readTable(q, "customer_payments");
    const applications = await readTable(q, "payment_applications");
    const byPayment = new Map<string, { invoiceId: string; amountCents: number }[]>();
    for (const app of applications) {
      const list = byPayment.get(app.payment_id) ?? [];
      list.push({ invoiceId: app.invoice_id, amountCents: app.amount_cents });
      byPayment.set(app.payment_id, list);
    }
    const rows = payments
      .sort((x, y) => compareText(y.received_on, x.received_on) || compareText(x.payment_ref, y.payment_ref))
      .map((p) => ({
        id: p.id,
        customerId: p.customer_id,
        receivedOn: p.received_on,
        amountCents: p.amount_cents,
        method: p.method,
        applications: byPayment.get(p.id) ?? [],
      }));
    return { result: { rows } };
  },
});
