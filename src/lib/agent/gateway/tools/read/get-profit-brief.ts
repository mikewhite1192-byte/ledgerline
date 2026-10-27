import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { briefPlainText } from "../../../../briefs/render";
import { readProfitView } from "../../../../briefs/view";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

const isOn = () => flags.profitBriefEnabled;

export const getProfitBrief = defineTool({
  name: "get_profit_brief",
  description:
    "Read one closed pay week's profit figures (the newest closed week unless periodStart is " +
    "given, the first day of a week from the last four): revenue, driver pay and margin in " +
    "integer cents, margin in basis points, loads priced and delivered, then the same by route " +
    "and by customer with each customer's average days to pay, the loads that could not be " +
    "priced, and the checked brief's words when one was written. Quote these figures exactly; " +
    "never add or derive one. This only reads.",
  tier: "read",
  roles: OPERATOR,
  label: "Read last week's profit figures",
  enabled: isOn,
  args: z.strictObject({ periodStart: dateField().optional() }),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    if (!isOn()) throw new Error("the profit brief is switched off");
    const today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const view = await readProfitView(q, today, a.periodStart ?? null, flags.profitBriefLimits, ctx.now);
    const closedWeeks = view.weeks.map((w) => ({ start: w.start, end: w.end }));
    // Only the last four closed weeks have figures here: for any other week, say which ones do
    // instead of answering for a different week.
    if (!view.week || !view.profit || (a.periodStart && a.periodStart !== view.week.start)) {
      return {
        result: { period: null, closedWeeks, totals: null, routes: [], customers: [], unpricedLoads: [], brief: null },
      };
    }
    const { totals, routes, customers, unpriced } = view.profit;
    return {
      result: {
        period: { start: view.week.start, end: view.week.end },
        closedWeeks,
        totals: {
          revenueCents: totals.revenueCents,
          driverPayCents: totals.driverPayCents,
          marginCents: totals.marginCents,
          marginBps: totals.marginBps,
          loadsPriced: totals.loads,
          loadsDelivered: totals.loadsDelivered,
        },
        routes: routes.slice(0, flags.profitBriefLimits.maxLanes).map((r) => ({
          route: r.route,
          loads: r.loads,
          revenueCents: r.revenueCents,
          driverPayCents: r.driverPayCents,
          marginCents: r.marginCents,
          marginBps: r.marginBps,
          revenuePerLoadedMileCents: r.centsPerLoadedMile,
        })),
        customers: customers.slice(0, flags.profitBriefLimits.maxCustomers).map((c) => ({
          customerId: c.customerId,
          customerName: c.customerName,
          loads: c.loads,
          revenueCents: c.revenueCents,
          marginCents: c.marginCents,
          marginBps: c.marginBps,
          meanDaysToPay: c.meanDays,
          paidInvoices: c.paidCount,
          paymentHabit: c.habit,
        })),
        unpricedLoads: unpriced.map((u) => ({ loadId: u.loadId, loadNumber: u.loadNumber, note: u.note })),
        brief:
          view.brief.kind === "drafted" && view.brief.brief.text !== null
            ? { text: briefPlainText(view.brief.brief.text), writtenAt: view.brief.brief.updatedAt }
            : null,
      },
    };
  },
});
