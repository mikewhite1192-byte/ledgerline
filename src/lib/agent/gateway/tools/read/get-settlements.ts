import { z } from "zod";
import { readDueWeekAndPay, readRowsWhereId } from "../../../../data/read";
import { readSettlementRows } from "../../../../settlements/list";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

export const getSettlements = defineTool({
  name: "get_settlements",
  description:
    "List one pay week's paystubs (the week paid next, the one the pay check reads, unless " +
    "periodId is given), in driver order: each one's driver, gross, deductions and net in " +
    "integer cents, status, the exception categories on its approval card, the auditor's " +
    "verdict, whether it is clean for Approve all clean, and parkedReason when it no longer " +
    "matches its records. noPaystubsYet true means only that this open week has no paystubs " +
    "yet. With runTheWeek true it is the week paid next and has pay: say plainly that pressing " +
    "Run the week on the Paystubs page under Pay runs it and makes paystubs for the drivers with " +
    "payable work; never say it was not run. With noPayYet true it has no pay yet: say so and " +
    "never point at Run the week. With waitsForWeekPaidNext true its pay runs after the week " +
    "paid next. weekPaidNext, when given, names the week paid next: say its dates. To preview " +
    "one driver, call explain_paystub with this periodId and the driver's id. This only reads; " +
    "explain_paystub explains one paystub line by line.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading this week's paystubs",
  args: z.strictObject({ periodId: idField().optional() }),
  refs: (a): GatewayRef[] => (a.periodId ? [{ table: "settlement_periods", id: a.periodId }] : []),
  run: async (q, _ctx, a) => {
    let period: { id: string; start: string; end: string; status: string } | null;
    // The week paid next and the pay check, read once: always for the default week, and for a
    // named week only when it is open with no paystubs (the hint below needs it).
    let weeks: Awaited<ReturnType<typeof readDueWeekAndPay>> | null = null;
    if (a.periodId) {
      // The ref check already proved the week is this carrier's; it may be older than the list.
      const [row] = await readRowsWhereId(q, "settlement_periods", "id", a.periodId);
      if (!row) throw new Error("period vanished after the ref check");
      period = { id: row.id, start: row.period_start, end: row.period_end, status: row.status };
    } else {
      // The week paid next (readDueWeek, D-093), the week the pay check and the sweep read: the
      // oldest open week with a paystub or a day that carries pay, else the newest open week.
      weeks = await readDueWeekAndPay(q);
      const due = weeks.due;
      // Status open is right: dueWeek picks only from open weeks.
      period = due ? { id: due.id, start: due.period_start, end: due.period_end, status: "open" } : null;
    }
    if (!period) return { result: { period: null, settlements: [], awaitingAuditor: 0 } };
    const { rows, awaitingAuditor } = await readSettlementRows(q, period.id);
    // An open week with no paystubs yet: not run, or run with no driver to pay. The period
    // records no run, so this says only that none exist yet, never which. Run the week is named
    // only for the week paid next with pay in it; any other empty open week says it has no pay
    // yet, or that its pay runs after the week paid next, and names that week.
    let empty: Record<string, unknown> = {};
    if (rows.length === 0 && period.status === "open") {
      weeks ??= await readDueWeekAndPay(q);
      const due = weeks.due;
      const isDue = due !== null && due.id === period.id;
      const hasPay = weeks.holdsPay(period);
      const next =
        due !== null && !isDue ? { weekPaidNext: { periodId: due.id, start: due.period_start, end: due.period_end } } : {};
      empty =
        isDue && hasPay
          ? { noPaystubsYet: true, runTheWeek: true }
          : hasPay
            ? { noPaystubsYet: true, waitsForWeekPaidNext: true, ...next }
            : { noPaystubsYet: true, noPayYet: true, ...next };
    }
    return {
      result: {
        period: { periodId: period.id, start: period.start, end: period.end, status: period.status },
        settlements: rows.map((r) => ({
          settlementId: r.id,
          driverId: r.driverId,
          driverCode: r.driverCode,
          driverName: r.driverName,
          grossCents: r.grossCents,
          deductionsCents: r.deductionsCents,
          netCents: r.netCents,
          status: r.status,
          exceptions: r.exceptions,
          auditorVerdict: r.auditor,
          auditorAgrees: r.auditorAgrees,
          clean: r.clean,
          parkedReason: r.parkedReason,
        })),
        // Cards still waiting for the auditor: none of them is clean yet.
        awaitingAuditor,
        ...empty,
      },
    };
  },
});
