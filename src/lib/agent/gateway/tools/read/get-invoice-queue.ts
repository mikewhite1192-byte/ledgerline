import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readInvoiceQueue } from "../../../../data/read";
import { lineSummary, splitInvoiceQueue } from "../../../../invoices/queue";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR } from "../shared";

export const getInvoiceQueue = defineTool({
  name: "get_invoice_queue",
  description:
    "List delivered loads that have no invoice yet. rows are the invoiceable loads, each with the " +
    "rules engine's total and lines in integer cents; each exception has the engine's reason (missing_rate, " +
    "missing_customer, not_delivered) and the records behind it. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading the invoice queue",
  args: z.strictObject({}),
  refs: (): GatewayRef[] => [],
  run: async (q) => {
    const { loads, customers } = await readInvoiceQueue(q, flags.invoicesStart);
    const queue = splitInvoiceQueue(loads, customers);
    return {
      result: {
        // rows are the invoiceable loads; a long list is cut from the end and says so.
        rows: queue.invoiceable.map((i) => ({
          loadId: i.load.id,
          loadNumber: i.load.loadNumber,
          customerId: i.load.customerId,
          deliveredOn: i.load.deliveredOn,
          amountCents: i.amountCents,
          lines: lineSummary(i.lines),
          sources: i.sources,
        })),
        exceptions: queue.exceptions.map((e) => ({
          loadId: e.load.id,
          loadNumber: e.load.loadNumber,
          reason: e.reason,
          sources: e.sources,
        })),
      },
    };
  },
});
