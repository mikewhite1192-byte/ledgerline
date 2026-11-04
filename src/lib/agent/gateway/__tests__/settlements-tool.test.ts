import { describe, expect, it } from "vitest";
import type { CarrierPlan } from "../../../seed/plan";
import { getSettlements, READ_NEXT } from "../tools/read/get-settlements";
import { context, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// get_settlements: with no periodId it lists the week paid next (the week the pay check and the
// sweep read), not the newest open week the roll opens empty. On an open week with no paystubs the
// result says only that none exist yet (the week records no run, so it never claims the week was
// not run), and points at Run the week only for the week paid next with pay in it.

const plan = blueRidgePlan();
const run = (args: { periodId?: string }, p: CarrierPlan = plan) =>
  planDb(p).withTenant(TENANT, (q) => getSettlements.run(q, context(), args, { screen: null, limit: null }));

// The plan's one open week (Oct 26 to Nov 1): loads delivered, no paystubs yet, so it is the week
// paid next.
const due = plan.rows.settlement_periods.find((p) => p.status === "open")!;
const NEWER_ID = "6c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
const NEWEST_ID = "7d2e3f4a-5b6c-4d7e-8f90-1a2b3c4d5e6f";

// The plan with more weeks, as the roll leaves it: each a copy of the open week's row.
function withWeeks(
  weeks: { id: string; start: string; end: string }[],
  over: (p: CarrierPlan) => CarrierPlan = (p) => p,
): CarrierPlan {
  const added = weeks.map((w) => ({ ...due, id: w.id, period_start: w.start, period_end: w.end, status: "open" as const }));
  return over({ ...plan, rows: { ...plan.rows, settlement_periods: [...plan.rows.settlement_periods, ...added] } });
}
const rolled = withWeeks([{ id: NEWER_ID, start: "2026-11-02", end: "2026-11-08" }]);

type Out = Record<string, unknown> & {
  period: { periodId: string; start: string; end: string; status: string } | null;
};

describe("get_settlements", () => {
  it("lists the week paid next by default, not the newer empty week the roll opened", async () => {
    const out = (await run({}, rolled)).result as Out;
    expect(out.period).toEqual({ periodId: due.id, start: "2026-10-26", end: "2026-11-01", status: "open" });
    // It has pay and no paystubs yet: Run the week makes them.
    expect(out.noPaystubsYet).toBe(true);
    expect(out.runTheWeek).toBe(true);
    // No paystubs is not the answer: the pay check and the preview answer before the run.
    expect(out.readNext).toBe(READ_NEXT);
    expect(out).not.toHaveProperty("noPayYet");
    expect(out).not.toHaveProperty("weekPaidNext");
  });

  it("keeps a named week exactly, and says the empty newer week has no pay yet and names the week paid next", async () => {
    const out = (await run({ periodId: NEWER_ID }, rolled)).result as Out;
    expect(out.period).toEqual({ periodId: NEWER_ID, start: "2026-11-02", end: "2026-11-08", status: "open" });
    expect(out.settlements).toEqual([]);
    expect(out.noPaystubsYet).toBe(true);
    expect(out.noPayYet).toBe(true);
    expect(out).not.toHaveProperty("runTheWeek");
    // No pay, nothing to preview.
    expect(out).not.toHaveProperty("readNext");
    expect(out.weekPaidNext).toEqual({ periodId: due.id, start: "2026-10-26", end: "2026-11-01" });
  });

  it("says a newer week with pay waits for the week paid next, never Run the week", async () => {
    const item = plan.rows.pay_items[0];
    const withPay = withWeeks([{ id: NEWER_ID, start: "2026-11-02", end: "2026-11-08" }], (p) => ({
      ...p,
      rows: {
        ...p.rows,
        pay_items: [...p.rows.pay_items, { ...item, id: "8e3f4a5b-6c7d-4e8f-9a01-2b3c4d5e6f70", item_date: "2026-11-03" }],
      },
    }));
    const out = (await run({ periodId: NEWER_ID }, withPay)).result as Out;
    expect(out.waitsForWeekPaidNext).toBe(true);
    expect(out.readNext).toBe(READ_NEXT);
    expect(out.weekPaidNext).toEqual({ periodId: due.id, start: "2026-10-26", end: "2026-11-01" });
    expect(out).not.toHaveProperty("runTheWeek");
    expect(out).not.toHaveProperty("noPayYet");
  });

  it("falls back to the newest open week when no open week has pay, and says it has none yet", async () => {
    // The plan's open week is paid out, and two empty weeks follow it.
    const closed = withWeeks(
      [
        { id: NEWER_ID, start: "2026-11-02", end: "2026-11-08" },
        { id: NEWEST_ID, start: "2026-11-09", end: "2026-11-15" },
      ],
      (p) => ({
        ...p,
        rows: {
          ...p.rows,
          settlement_periods: p.rows.settlement_periods.map((w) => (w.id === due.id ? { ...w, status: "paid" as const } : w)),
        },
      }),
    );
    const out = (await run({}, closed)).result as Out;
    expect(out.period?.periodId).toBe(NEWEST_ID);
    expect(out.noPaystubsYet).toBe(true);
    expect(out.noPayYet).toBe(true);
    expect(out).not.toHaveProperty("runTheWeek");
    expect(out).not.toHaveProperty("readNext");
    // It is the week paid next itself, so no other week is named.
    expect(out).not.toHaveProperty("weekPaidNext");
  });

  it("says Run the week for the week paid next named by id, as for the default", async () => {
    const out = (await run({ periodId: due.id }, rolled)).result as Out;
    expect(out.period?.periodId).toBe(due.id);
    expect(out.noPaystubsYet).toBe(true);
    expect(out.runTheWeek).toBe(true);
    expect(out.readNext).toBe(READ_NEXT);
    expect(out).not.toHaveProperty("notRunYet");
  });

  it("never says so for a week that has paystubs", async () => {
    const paid = plan.rows.settlement_periods.find((p) => p.status === "paid")!;
    const out = (await run({ periodId: paid.id })).result as Out;
    expect((out.settlements as unknown[]).length).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("noPaystubsYet");
    expect(out).not.toHaveProperty("runTheWeek");
    expect(out).not.toHaveProperty("noPayYet");
    expect(out).not.toHaveProperty("readNext");
  });

  it("answers no week when none is open", async () => {
    const none = {
      ...plan,
      rows: { ...plan.rows, settlement_periods: plan.rows.settlement_periods.filter((p) => p.status !== "open") },
    };
    const out = (await run({}, none)).result as Out;
    expect(out).toEqual({ period: null, settlements: [], awaitingAuditor: 0 });
  });

  it("never claims the week was not run, and names the week paid next as the default", () => {
    expect(getSettlements.description).toContain("never say it was not run");
    expect(getSettlements.description).not.toMatch(/means the week has not been run/);
    expect(getSettlements.description).toContain("the week paid next");
    expect(getSettlements.description).toContain("runs it and makes paystubs for the drivers with payable work");
    expect(getSettlements.description).not.toContain("newest open week");
  });

  it("sends a week with no paystubs to the pay check and the preview, never to no problems", () => {
    expect(getSettlements.description).toContain("never no problems or no pay");
    expect(getSettlements.description).toContain("for who has a problem call run_checks with this periodId");
    expect(getSettlements.description).toContain("call explain_paystub with this periodId");
    expect(getSettlements.description).toContain("(from run_checks, or from get_settlements for a week that has paystubs)");
    expect(READ_NEXT).toContain("run_checks with this periodId");
    expect(READ_NEXT).toContain("explain_paystub with this periodId and a driver's id (from run_checks, or from get_settlements for a week that has paystubs)");
  });
});
