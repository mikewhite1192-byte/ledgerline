import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readCashFridayInput } from "../../../../data/read";
import { computeCashFriday } from "../../../../rules-engine";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR } from "../shared";

// The receipt lines sent back: the counted ones come first, so the cut drops the least likely.
export const CASH_LINES_MAX = 20;

export const getCashFriday = defineTool({
  name: "get_cash_friday",
  description:
    "Work out whether the carrier can cover Friday's driver pay run, as the rules engine does on " +
    "the Cash page: cash on hand, customer payments expected by pay day, the pay run, fuel card " +
    "loads and vendor bills due, and the gap (below zero is a short), in integer cents. When short, " +
    "options are the moves the engine found (factor invoices, move a flexible bill, chase a late " +
    "payer), each with its figures. Also the latest stored check's id and the open cards' ids. " +
    "This only reads; a person runs a check and decides each card on the Cash page.",
  tier: "read",
  roles: OPERATOR,
  label: "Checking Friday's pay run",
  enabled: () => flags.cashFridayEnabled,
  args: z.strictObject({}),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx) => {
    if (!flags.cashFridayEnabled) throw new Error("cash friday is switched off");
    const input = await readCashFridayInput(q, ctx.timeZone, flags.cashFridayLimits);
    const r = computeCashFriday(input, localDateOf(ctx.now.toISOString(), ctx.timeZone));
    if (!r.ok) return { result: { refusal: r.refusal } };
    const [latest] = await q.query<{ id: string; created_at: string }>(
      `SELECT CAST(id AS text) AS id, CAST(created_at AS text) AS created_at
         FROM cash_checks WHERE tenant_id = current_tenant_id()
        ORDER BY created_at DESC, id LIMIT 1`,
    );
    const cards = await q.query<{ id: string; kind: string; status: string }>(
      `SELECT CAST(id AS text) AS id, kind, status
         FROM proposals
        WHERE tenant_id = current_tenant_id() AND origin = 'engine'
          AND kind IN ('factoring_request', 'bill_defer', 'collections_chase')
          AND status IN ('proposed', 'approved', 'executing')
        ORDER BY created_at, id`,
    );
    return {
      result: {
        asOf: r.asOf,
        payDay: r.payDay,
        periodId: r.periodId,
        payRunSource: r.payRunSource,
        figures: r.figures,
        linesTotal: r.lines.length,
        // rows are the receipt lines, counted ones first; the gateway cuts a long list from the end.
        rows: r.lines.slice(0, CASH_LINES_MAX).map((l) => ({
          invoiceId: l.invoiceId,
          invoiceNumber: l.invoiceNumber,
          customerId: l.customerId,
          balanceCents: l.balanceCents,
          dueOn: l.dueOn,
          expectedOn: l.expectedOn,
          onTimeBps: l.onTimeBps,
          label: l.label,
          status: l.status,
          expectedCents: l.expectedCents,
        })),
        // Each option names its records by id; the rows name each invoice and customer.
        options: r.options.map((o) => {
          if (o.kind === "factoring_request") {
            return {
              kind: o.kind,
              periodId: o.subjectId,
              amountCents: o.amountCents,
              feeCents: o.feeCents,
              reserveCents: o.reserveCents,
              coversShort: o.coversShort,
              invoiceIds: o.invoices.map((i) => i.invoiceId),
            };
          }
          if (o.kind === "bill_defer") {
            return {
              kind: o.kind,
              billId: o.subjectId,
              billRef: o.billRef,
              amountCents: o.amountCents,
              dueOn: o.dueOn,
              deferredTo: o.deferredTo,
              coversShort: o.coversShort,
            };
          }
          return {
            kind: o.kind,
            customerId: o.subjectId,
            amountCents: o.amountCents,
            label: o.label,
            overdueInvoices: o.overdueInvoices,
          };
        }),
        latestCheckId: latest?.id ?? null,
        openCards: cards.map((c) => ({ proposalId: c.id, kind: c.kind, status: c.status })),
      },
    };
  },
});
