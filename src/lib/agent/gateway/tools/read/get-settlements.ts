import { z } from "zod";
import { readRowsWhereId } from "../../../../data/read";
import { readPeriods, readSettlementRows } from "../../../../settlements/list";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

export const getSettlements = defineTool({
  name: "get_settlements",
  description:
    "List one pay week's paystubs (the newest open week unless periodId is given), in driver " +
    "order: each one's driver, gross, deductions and net in integer cents, status, the exception " +
    "categories on its approval card, the auditor's verdict, whether it is clean for Approve all " +
    "clean, and parkedReason when it no longer matches its records. This only reads; " +
    "explain_paystub explains one paystub line by line.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading this week's paystubs",
  args: z.strictObject({ periodId: idField().optional() }),
  refs: (a): GatewayRef[] => (a.periodId ? [{ table: "settlement_periods", id: a.periodId }] : []),
  run: async (q, _ctx, a) => {
    let period: { id: string; start: string; end: string; status: string } | null;
    if (a.periodId) {
      // The ref check already proved the week is this carrier's; it may be older than the list.
      const [row] = await readRowsWhereId(q, "settlement_periods", "id", a.periodId);
      if (!row) throw new Error("period vanished after the ref check");
      period = { id: row.id, start: row.period_start, end: row.period_end, status: row.status };
    } else {
      period = (await readPeriods(q)).find((p) => p.status === "open") ?? null;
    }
    if (!period) return { result: { period: null, settlements: [], awaitingAuditor: 0 } };
    const { rows, awaitingAuditor } = await readSettlementRows(q, period.id);
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
      },
    };
  },
});
