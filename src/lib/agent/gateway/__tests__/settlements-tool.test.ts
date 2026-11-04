import { describe, expect, it } from "vitest";
import type { CarrierPlan } from "../../../seed/plan";
import { MAX_RESULT_CHARS } from "../index";
import {
  getSettlements,
  PAYABLE_DRIVERS_CAP,
  PAYABLE_DRIVERS_CHARS,
  payableDriversList,
  READ_NEXT,
} from "../tools/read/get-settlements";
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

  // Production, Nov 4: "Why is Monique's pay short this week?" before Run the week had no way to
  // her driver id, so it spent its clock on two reports. The empty week lists the drivers the run
  // would draft for, by the run's own statement, with the ids explain_paystub takes.
  it("lists an empty week's payable drivers with their ids and names, as the run would draft them", async () => {
    const out = (await run({}, rolled)).result as Out & {
      payableDrivers: { driverId: string; driverCode: string; driverName: string }[];
      payableDriversTotal: number;
    };
    expect(out.payableDrivers.length).toBeGreaterThan(0);
    expect(out.payableDriversTotal).toBe(out.payableDrivers.length);
    const monique = out.payableDrivers.find((d) => d.driverCode === "BR-D07");
    const row = plan.rows.drivers.find((d) => d.code === "BR-D07")!;
    expect(monique).toEqual({ driverId: row.id, driverCode: "BR-D07", driverName: `${row.first_name} ${row.last_name}` });
    // Each one is a driver with work in the week or an advance still owed, in code order.
    const codes = out.payableDrivers.map((d) => d.driverCode);
    expect([...codes].sort()).toEqual(codes);
    expect(PAYABLE_DRIVERS_CAP).toBe(40);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_RESULT_CHARS);
    expect(getSettlements.description).toContain("takes that driver's driverId from it to explain_paystub");
    expect(READ_NEXT).toContain("takes that driver's driverId from payableDrivers here to explain_paystub");
  });

  // Long names: 40 entries of the list alone would cross the gateway's cap and drop the whole
  // result, so the list stops at its character budget and the total still counts every driver.
  it("cuts the payable list at its character budget when the names are long, and still counts them all", async () => {
    const long = (n: string) => `${n} ${"x".repeat(240)}`;
    const p: CarrierPlan = {
      ...rolled,
      rows: {
        ...rolled.rows,
        drivers: rolled.rows.drivers.map((d) => ({ ...d, first_name: long(d.first_name), last_name: long(d.last_name) })),
      },
    };
    const out = (await run({}, p)).result as Out & {
      payableDrivers: { driverId: string; driverCode: string; driverName: string }[];
      payableDriversTotal: number;
    };
    const full = (await run({}, rolled)).result as Out & { payableDriversTotal: number };
    expect(out.payableDriversTotal).toBe(full.payableDriversTotal);
    expect(out.payableDrivers.length).toBeGreaterThan(0);
    expect(out.payableDrivers.length).toBeLessThan(out.payableDriversTotal);
    expect(JSON.stringify(out.payableDrivers).length).toBeLessThanOrEqual(PAYABLE_DRIVERS_CHARS);
    expect(out.payableDrivers[0].driverName.length).toBeGreaterThan(480);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_RESULT_CHARS);
    expect(PAYABLE_DRIVERS_CHARS).toBeLessThan(MAX_RESULT_CHARS);
  });

  it("keeps 40 as the most entries, and the budget holds to the character", () => {
    const short = Array.from({ length: 60 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000000${String(10 + i)}`,
      code: `D${String(i)}`,
      first_name: "A",
      last_name: "B",
    }));
    expect(payableDriversList(short)).toHaveLength(PAYABLE_DRIVERS_CAP);
    const wide = short.map((d) => ({ ...d, first_name: "y".repeat(400) }));
    const list = payableDriversList(wide);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(PAYABLE_DRIVERS_CHARS);
    // One more entry would have crossed the budget.
    expect(list.length).toBeLessThan(PAYABLE_DRIVERS_CAP);
    expect(JSON.stringify([...list, list[0]]).length).toBeGreaterThan(PAYABLE_DRIVERS_CHARS);
    expect(payableDriversList([])).toEqual([]);
  });

  it("lists no drivers for a week with no pay", async () => {
    const out = (await run({ periodId: NEWER_ID }, rolled)).result as Out;
    expect(out.noPayYet).toBe(true);
    expect(out).not.toHaveProperty("payableDrivers");
  });

  it("never says so for a week that has paystubs", async () => {
    const paid = plan.rows.settlement_periods.find((p) => p.status === "paid")!;
    const out = (await run({ periodId: paid.id })).result as Out;
    expect((out.settlements as unknown[]).length).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("noPaystubsYet");
    expect(out).not.toHaveProperty("runTheWeek");
    expect(out).not.toHaveProperty("noPayYet");
    expect(out).not.toHaveProperty("readNext");
    expect(out).not.toHaveProperty("payableDrivers");
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

  // Production, Nov 4: asked about this week's pay before Run the week, one turn read the paystubs
  // alone and was told to answer before the pay check came back, and another spent its clock on
  // the pay summary and the driver ranking. The pay check rides with the first read, and neither
  // report is named for that week's problems or one driver's pay.
  it("sends the pay check with the first read and keeps the summary and ranking out of the week", () => {
    expect(getSettlements.description).toContain(
      "send run_checks with the week paid next's periodId (the state summary names it) in the same response as this call",
    );
    expect(getSettlements.description).toContain(
      "Never call report_driver_pay_summary or report_driver_insights for that week's problems or one driver's pay",
    );
    expect(READ_NEXT).toContain("call it next unless it already came back");
    expect(READ_NEXT).toContain("report_driver_pay_summary has no rows for this week");
    expect(READ_NEXT).toContain("neither answers this week's problems or one driver's pay");
    for (const text of [getSettlements.description, READ_NEXT]) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
