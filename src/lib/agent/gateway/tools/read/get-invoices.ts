import { z } from "zod";
import { readRowsWhereId, readTable } from "../../../../data/read";
import { compareText } from "../../../../rules-engine";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

const INVOICE_STATUSES = ["open", "partially_paid", "paid", "void"] as const;

export const getInvoices = defineTool({
  name: "get_invoices",
  description:
    "List customer invoices, newest first, optionally for one customer and one status. Money is " +
    "in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading invoices",
  args: z.strictObject({
    customerId: idField().optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
  }),
  refs: (a): GatewayRef[] => (a.customerId ? [{ table: "customers", id: a.customerId }] : []),
  run: async (q, _ctx, a) => {
    const invoices = a.customerId
      ? await readRowsWhereId(q, "invoices", "customer_id", a.customerId)
      : await readTable(q, "invoices");
    const rows = invoices
      .filter((i) => !a.status || i.status === a.status)
      .sort((x, y) => compareText(y.issued_on, x.issued_on) || compareText(x.invoice_number, y.invoice_number))
      .map((i) => ({
        id: i.id,
        invoiceNumber: i.invoice_number,
        source: i.source,
        loadId: i.load_id,
        customerId: i.customer_id,
        amountCents: i.amount_cents,
        issuedOn: i.issued_on,
        dueOn: i.due_on,
        status: i.status,
        paidOn: i.paid_on,
      }));
    return { result: { rows } };
  },
});
