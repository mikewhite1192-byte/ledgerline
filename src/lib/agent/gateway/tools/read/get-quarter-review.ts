import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { QUARTER_SECTIONS, readQuarterView } from "../../../../briefs/quarter-review";
import { briefPlainText } from "../../../../briefs/render";
import { QUARTER_CUSTOMERS } from "../../../../rules-engine";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR } from "../shared";

const isOn = () => flags.quarterReviewEnabled;

export const getQuarterReview = defineTool({
  name: "get_quarter_review",
  description:
    "Read the current calendar quarter so far, in the carrier's time zone: pay runs (paid, " +
    "approved, open), gross, deductions and net pay of the closed runs, revenue, driver pay and " +
    "margin on priced loads, invoices issued and payments received, open receivables, money " +
    "recovered (detention, pay corrections, advances), the paystub problems and the agent's fixes " +
    "by status and kind, the top customers, and the checked review's four lists when one was " +
    "written. Money is integer cents, margin in basis points. Quote these figures exactly; never " +
    "add or derive one. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Read the quarter so far",
  enabled: isOn,
  args: z.strictObject({}),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx) => {
    if (!isOn()) throw new Error("the quarter review is switched off");
    const today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const view = await readQuarterView(q, today, ctx.timeZone, flags.quarterReviewLimits.maxInputChars, ctx.now);
    const { quarter: qr, review } = view;
    return {
      result: {
        quarter: { start: qr.quarter.start, end: qr.quarter.end },
        soFar: { start: qr.window.start, end: qr.window.end },
        payRuns: {
          runs: qr.pay.runs,
          paid: qr.pay.paid,
          approved: qr.pay.approved,
          open: qr.pay.open,
          paystubsInClosedRuns: qr.pay.paystubs,
          driversPaid: qr.pay.drivers,
          grossCents: qr.pay.grossCents,
          deductionsCents: qr.pay.deductionsCents,
          netCents: qr.pay.netCents,
          paystubProblems: qr.pay.exceptionCount,
          paystubsWithAProblem: qr.pay.withProblem,
        },
        margin: {
          loadsDelivered: qr.margin.loadsDelivered,
          loadsPriced: qr.margin.loads,
          revenueCents: qr.margin.revenueCents,
          driverPayCents: qr.margin.driverPayCents,
          marginCents: qr.margin.marginCents,
          marginBps: qr.margin.marginBps,
        },
        invoiced: { count: qr.invoiced.count, cents: qr.invoiced.cents },
        received: { count: qr.received.count, cents: qr.received.cents },
        receivables: { openCents: qr.receivables.openCents, pastDueCents: qr.receivables.pastDueCents },
        recovered: { ...qr.recovered },
        fixes: {
          suggested: qr.exceptions.suggested,
          done: qr.exceptions.done,
          waiting: qr.exceptions.waiting,
          declined: qr.exceptions.declined,
          failed: qr.exceptions.failed,
          byKind: qr.exceptions.byKind.map((k) => ({ kind: k.label, count: k.count, amountCents: k.amountCents })),
          unbilledDetentionLoads: qr.exceptions.unbilledLoads,
          unbilledDetentionCents: qr.exceptions.unbilledCents,
        },
        customers: qr.customers.slice(0, QUARTER_CUSTOMERS).map((c) => ({
          customerId: c.customerId,
          customerName: c.customerName,
          invoices: c.invoices,
          invoicedCents: c.invoicedCents,
          payments: c.payments,
          receivedCents: c.receivedCents,
          openCents: c.openCents,
          meanDaysToPay: c.meanDays,
          paymentHabit: c.habit,
        })),
        review:
          review.kind === "drafted" && review.review.body !== null
            ? {
                writtenAt: review.review.updatedAt,
                figuresChangedSince: review.changed,
                ...Object.fromEntries(
                  QUARTER_SECTIONS.map((s) => [s, (review.review.body?.[s] ?? []).map(briefPlainText)]),
                ),
              }
            : null,
      },
    };
  },
});
