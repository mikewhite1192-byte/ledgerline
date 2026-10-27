import { z } from "zod";
import { readRowsWhereId, readSettlementInput } from "../../../../data/read";
import { settleDriver } from "../../../../rules-engine";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

export const explainPaystub = defineTool({
  name: "explain_paystub",
  description:
    "Explain one driver's pay for one pay period line by line: the stored settlement lines when " +
    "the period has been settled, otherwise the rules engine's computed lines. Earnings are " +
    "positive and deductions negative, in integer cents, each with the records it came from.",
  tier: "read",
  roles: OPERATOR,
  label: "Explaining the pay stub",
  args: z.strictObject({ driverId: idField(), periodId: idField() }),
  refs: (a) => [
    { table: "drivers", id: a.driverId },
    { table: "settlement_periods", id: a.periodId },
  ],
  run: async (q, _ctx, a) => {
    const settlements = await readRowsWhereId(q, "settlements", "period_id", a.periodId);
    const stored = settlements.find((s) => s.driver_id === a.driverId);
    if (stored) {
      const lines = await readRowsWhereId(q, "settlement_lines", "settlement_id", stored.id);
      return {
        result: {
          driverId: a.driverId,
          periodId: a.periodId,
          computed: false,
          settlementId: stored.id,
          status: stored.status,
          grossCents: stored.gross_cents,
          deductionsCents: stored.deductions_cents,
          netCents: stored.net_cents,
          carryForwardCents: stored.carry_forward_cents,
          rows: [...lines]
            .sort((x, y) => x.seq - y.seq)
            .map((l) => ({
              seq: l.seq,
              kind: l.kind,
              label: l.label,
              amountCents: l.amount_cents,
              sources: l.sources,
            })),
        },
      };
    }
    const result = settleDriver(await readSettlementInput(q, a.driverId, a.periodId));
    return {
      result: {
        driverId: a.driverId,
        periodId: a.periodId,
        computed: true,
        grossCents: result.grossCents,
        deductionsCents: result.deductionsCents,
        netCents: result.netCents,
        carryForwardCents: result.carryForwardCents,
        exceptions: result.exceptions.map((e) => ({
          kind: e.kind,
          category: e.category,
          amountCents: e.amountCents ?? null,
          sources: e.sources,
        })),
        notes: result.notes.map((n) => ({
          kind: n.kind,
          category: n.category,
          amountCents: n.amountCents,
        })),
        rows: result.lines.map((l) => ({
          seq: l.seq,
          kind: l.kind,
          label: l.label,
          amountCents: l.amountCents,
          sources: l.sources,
        })),
      },
    };
  },
});
