import { describe, expect, it } from "vitest";
import { centsIn, maskFigures } from "../../operator/figures";
import { explainPaystub, lineSubtotals } from "../tools/read/explain-paystub";
import { context, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// explain_paystub adds up each kind's lines in integer cents, with the number of loads. Production,
// Nov 4: asked why Monique's pay was short, the answer added the load pay lines and the
// reimbursement lines itself, and both totals were withheld as figures no record gave.

const plan = blueRidgePlan();
const due = plan.rows.settlement_periods.find((p) => p.status === "open")!;
const monique = plan.rows.drivers.find((d) => d.code === "BR-D07")!;

type Row = { kind: string; amountCents: number };
type Out = { computed: boolean; subtotals: Record<string, number>; rows: Row[] };

const dollars = (cents: number) => {
  const c = Math.abs(cents);
  return `$${Math.trunc(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;
};

describe("explain_paystub subtotals", () => {
  it("adds up each kind's lines and counts the loads, signed as the lines are", () => {
    const rows: Row[] = [
      { kind: "load_pay", amountCents: 80_000 },
      { kind: "load_pay", amountCents: 90_050 },
      { kind: "load_pay", amountCents: 70_000 },
      { kind: "reimbursement", amountCents: 4_500 },
      { kind: "reimbursement", amountCents: 3_000 },
      { kind: "escrow", amountCents: -10_000 },
    ];
    expect(lineSubtotals(rows)).toEqual({
      loadCount: 3,
      loadPayCents: 240_050,
      reimbursementsCents: 7_500,
      escrowCents: -10_000,
    });
    expect(lineSubtotals([])).toEqual({ loadCount: 0 });
  });

  it("gives a previewed week's subtotals from its own lines, and an answer quoting them stays verified", async () => {
    const out = (
      await planDb(plan).withTenant(TENANT, (q) =>
        explainPaystub.run(q, context(), { driverId: monique.id, periodId: due.id }, { screen: null, limit: null }),
      )
    ).result as Out;
    expect(out.computed).toBe(true);
    const loads = out.rows.filter((r) => r.kind === "load_pay");
    expect(loads.length).toBeGreaterThan(1);
    expect(out.subtotals).toEqual(lineSubtotals(out.rows));
    expect(out.subtotals.loadCount).toBe(loads.length);
    expect(out.subtotals.loadPayCents).toBe(loads.reduce((t, r) => t + r.amountCents, 0));
    // From the lines alone the loads' total is withheld; with the subtotal it is allowed.
    const answer = `${loads.length} loads for ${dollars(out.subtotals.loadPayCents)}.`;
    expect(maskFigures(answer, centsIn({ rows: out.rows })).masked).toBe(1);
    expect(maskFigures(answer, centsIn(out))).toEqual({ text: answer, masked: 0 });
    expect(explainPaystub.description).toContain("never add lines yourself");
    expect(explainPaystub.description).not.toMatch(/[\u2013\u2014]/);
  });
});
