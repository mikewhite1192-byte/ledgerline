import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readReceivablesInput, readTable } from "../../../../data/read";
import { planCollections } from "../../../../rules-engine/collections";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// The most late invoices one call returns; the rest are counted, never listed. Twenty rows ran past
// the gateway's result cap (MAX_RESULT_CHARS), which cut two more and added a second, smaller
// count beside total; twelve fit whole, so total and omitted are the only counts the model sees.
export const COLLECTIONS_TOOL_MAX = 12;

export const getCollections = defineTool({
  name: "get_collections",
  description:
    "ONLY the 30+ day reminder list: invoices 30 or more days past due on today's carrier date. " +
    "For all overdue invoices, or how many invoices are past due, use get_ar_aging instead; this " +
    "list leaves out every invoice 1 to 29 days late. Rows come most overdue first, as the " +
    "rules engine plans payment reminders: each with its balance in integer cents, days late, the " +
    "reminder stage (30, 60 or 90), the tone the customer's payment history sets (friendly, direct " +
    "or firm), and whether a reminder is drafted for that stage (status none, drafting, drafted, " +
    "refused, over_cap, approved or rejected). customerId keeps one customer. Reminders are drafted " +
    "and approved on the Collections page; this only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Looked up late invoices and reminders",
  enabled: () => flags.collectionsEnabled,
  args: z.strictObject({
    customerId: idField().optional(),
  }),
  refs: (a): GatewayRef[] => (a.customerId ? [{ table: "customers", id: a.customerId }] : []),
  run: async (q, ctx, a) => {
    if (!flags.collectionsEnabled) throw new Error("collections is switched off");
    const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const input = await readReceivablesInput(q, asOf);
    const candidates = planCollections(input, a.customerId ? [a.customerId] : null, flags.collectionsLimits.minDaysLate);
    const drafts = await readTable(q, "collection_drafts");
    const byKey = new Map(drafts.map((d) => [`${d.invoice_id}:${d.stage}`, d]));
    const shown = candidates.slice(0, COLLECTIONS_TOOL_MAX);
    return {
      result: {
        asOf,
        minDaysLate: flags.collectionsLimits.minDaysLate,
        total: candidates.length,
        // A long list is cut from the end (the least overdue) and says how many were left out.
        omitted: candidates.length - shown.length,
        rows: shown.map((c) => ({
          invoiceId: c.invoiceId,
          invoiceNumber: c.invoiceNumber,
          customerId: c.customerId,
          amountCents: c.amountCents,
          balanceCents: c.balanceCents,
          dueOn: c.dueOn,
          daysLate: c.daysLate,
          stage: c.stage,
          tone: c.tone,
          paymentProfile: c.profile.label,
          reminder: byKey.get(`${c.invoiceId}:${c.stage}`)?.status ?? "none",
          sources: c.sources,
        })),
      },
    };
  },
});
