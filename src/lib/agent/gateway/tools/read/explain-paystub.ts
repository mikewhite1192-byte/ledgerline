import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readRowsWhereId, readSettlementInput } from "../../../../data/read";
import { settleDriver } from "../../../../rules-engine";
import { findContradictions, readSourceFacts } from "../../../../settlements/contradiction";
import { readStoredLines } from "../../../../settlements/stored";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

export const explainPaystub = defineTool({
  name: "explain_paystub",
  description:
    "Explain one driver's pay for one pay period line by line: the stored settlement lines when " +
    "the period has been settled, otherwise the rules engine's computed lines. Earnings are " +
    "positive and deductions negative, in integer cents, each with the records it came from. A " +
    "note insurance_exempt means the driver carries their own insurance, so no daily insurance " +
    "line applies; parkedReason says why a stored paystub no longer matches its records. A stored " +
    "line with namedByPerson true was typed by staff and cites one record in sourceRef; " +
    "contradictions lists each line that does not match the record it cites, as the approval check " +
    "would find it now.",
  tier: "read",
  roles: OPERATOR,
  label: "Explaining the pay stub",
  args: z.strictObject({ driverId: idField(), periodId: idField() }),
  refs: (a) => [
    { table: "drivers", id: a.driverId },
    { table: "settlement_periods", id: a.periodId },
  ],
  run: async (q, _ctx, a) => {
    const [driver] = await readRowsWhereId(q, "drivers", "id", a.driverId);
    if (!driver) throw new Error("driver vanished after the ref check");
    // Why an exempt driver's paystub has no insurance line (the engine never charges one).
    const exemptNotes = driver.own_insurance
      ? [{ kind: "insurance" as const, category: "insurance_exempt" as const, amountCents: 0 }]
      : [];
    const settlements = await readRowsWhereId(q, "settlements", "period_id", a.periodId);
    const stored = settlements.find((s) => s.driver_id === a.driverId);
    if (stored) {
      const lines = await readRowsWhereId(q, "settlement_lines", "settlement_id", stored.id);
      // The approval check's own verdict, as code finds it now; only while named lines are on.
      let contradictions: { category: string; source: { table: string; id: string } }[] = [];
      if (flags.namedLines.enabled) {
        const payLines = await readStoredLines(q, stored.id);
        contradictions = findContradictions(
          payLines,
          await readSourceFacts(q, payLines, a.driverId),
          stored.id,
        ).map((p) => ({ category: p.category, source: p.source }));
      }
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
          parkedReason: stored.parked_reason,
          notes: exemptNotes,
          contradictions,
          rows: [...lines]
            .sort((x, y) => x.seq - y.seq)
            .map((l) => ({
              seq: l.seq,
              kind: l.kind,
              label: l.label,
              amountCents: l.amount_cents,
              sources: l.sources,
              // Who typed it stays out: only that a person did, and the record it cites.
              sourceRef: l.source_ref,
              namedByPerson: l.entered_by !== null,
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
        notes: [
          ...result.notes.map((n) => ({
            kind: n.kind,
            category: n.category,
            amountCents: n.amountCents,
          })),
          ...exemptNotes,
        ],
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
