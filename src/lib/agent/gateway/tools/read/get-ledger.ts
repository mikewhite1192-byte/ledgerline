import { z } from "zod";
import { readRowsWhereId, readTable } from "../../../../data/read";
import { compareText } from "../../../../rules-engine";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getLedger = defineTool({
  name: "get_ledger",
  description:
    "Read one driver's pay ledger: each pay period with its settlement status, gross, " +
    "deductions, net and carry-forward, newest first. Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the pay ledger",
  args: z.strictObject({ driverId: idField() }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const periods = await readTable(q, "settlement_periods");
    const settlements = await readRowsWhereId(q, "settlements", "driver_id", a.driverId);
    const byPeriod = new Map(settlements.map((s) => [s.period_id, s]));
    const rows = periods
      .sort((x, y) => compareText(y.period_start, x.period_start))
      .map((p) => {
        const s = byPeriod.get(p.id);
        return {
          periodId: p.id,
          periodStart: p.period_start,
          periodEnd: p.period_end,
          periodStatus: p.status,
          settlement: s
            ? {
                id: s.id,
                status: s.status,
                grossCents: s.gross_cents,
                deductionsCents: s.deductions_cents,
                netCents: s.net_cents,
                carryForwardCents: s.carry_forward_cents,
                exceptionCount: s.exception_count,
                paidAt: s.paid_at,
              }
            : null,
        };
      });
    return { result: { driverId: a.driverId, rows } };
  },
});
