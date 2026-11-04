import { describe, expect, it } from "vitest";
import { checkInputOf } from "../../../data/records";
import { runAllChecks } from "../../../rules-engine";
import { instantAt } from "../../../seed/calendar";
import type { CarrierPlan } from "../../../seed/plan";
import { callTool } from "../index";
import { runChecks } from "../tools/read/run-checks";
import type { GatewayContext } from "../types";
import { context, fixedClock } from "./fake-db";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "./plan-db";

// run_checks with periodId lists what the pay check lists for that week: only the pay findings
// whose record at fault falls in the week (findingInWeek, the sweep's own filter), so a paid
// week's problem is never named as the open week's. Without periodId the list is unchanged. No
// database, no clock, no network.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(PLAN_ANCHOR, 12, 0, zone)), timeZone: zone });

const open = plan.rows.settlement_periods.find((p) => p.status === "open")!;
const paid = plan.rows.settlement_periods.find((p) => p.status === "paid" && p.period_start === "2026-10-12")!;

// The plan with its load delivered without a rate moved into the paid week of Oct 12, so one pay
// finding falls in a paid week and the rest in the open week.
const noRate = runAllChecks(checkInputOf(plan.rows)).find((f) => f.check === "delivered_without_rate")!;
const moved: CarrierPlan = {
  ...plan,
  rows: {
    ...plan.rows,
    loads: plan.rows.loads.map((l) => (l.id === noRate.sources[0].id ? { ...l, delivered_on: "2026-10-14" } : l)),
  },
};

type Row = { check: string; category: string; driverId: string | null; sources: { table: string; id: string }[] };

async function rows(args: Record<string, string>, p: CarrierPlan = moved): Promise<Row[]> {
  const call = { id: "call-1", name: "run_checks", argumentsJson: JSON.stringify(args) };
  const out = await callTool(ctx, call, { db: planDb(p), clock: fixedClock });
  if (out.decision !== "allowed") throw new Error(`not allowed: ${out.decision}`);
  return (out.result as { rows: Row[] }).rows;
}

const checks = (list: Row[]) => list.map((r) => r.check);

describe("run_checks for one week", () => {
  it("keeps only the open week's pay findings, never the paid week's", async () => {
    const week = checks(await rows({ periodId: open.id }));
    expect(week).toEqual(
      expect.arrayContaining(["duplicate_advance", "fuel_on_wrong_driver", "insurance_day_not_driven", "missing_reimbursement"]),
    );
    expect(week).not.toContain("delivered_without_rate");
  });

  it("lists the paid week's own finding for that week", async () => {
    const week = await rows({ periodId: paid.id });
    expect(checks(week)).toContain("delivered_without_rate");
    expect(checks(week)).not.toContain("duplicate_advance");
    expect(week.find((r) => r.check === "delivered_without_rate")?.sources).toEqual(noRate.sources);
  });

  it("lists every week's pay findings without periodId, as before", async () => {
    const all = checks(await rows({}));
    for (const check of ["duplicate_advance", "insurance_day_not_driven", "delivered_without_rate"]) {
      expect(all).toContain(check);
    }
    // The open week's pay findings are the full list's less the paid week's one.
    const pay = new Set<string>(runAllChecks(checkInputOf(moved.rows)).map((f) => f.check));
    const week = checks(await rows({ periodId: open.id })).filter((c) => pay.has(c));
    expect(week.length).toBe(all.filter((c) => pay.has(c)).length - 1);
  });

  it("names the over-limit balance in the open week only, since it is what a driver owes now", async () => {
    expect(checks(await rows({}))).toContain("over_advance_limit");
    expect(checks(await rows({ periodId: open.id }))).toContain("over_advance_limit");
    expect(checks(await rows({ periodId: paid.id }))).not.toContain("over_advance_limit");
  });

  it("narrows one week to one driver", async () => {
    const dup = runAllChecks(checkInputOf(plan.rows)).find((f) => f.check === "duplicate_advance")!;
    const mine = await rows({ periodId: open.id, driverId: dup.driverId! });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.driverId === dup.driverId)).toBe(true);
  });

  it("refuses a week this carrier does not hold, by the ref check", async () => {
    const call = {
      id: "call-1",
      name: "run_checks",
      argumentsJson: JSON.stringify({ periodId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f" }),
    };
    const out = await callTool(ctx, call, { db: planDb(moved), clock: fixedClock });
    expect(out).toMatchObject({ decision: "blocked", reason: "unknown_record" });
  });

  it("says what periodId does", () => {
    expect(runChecks.description).toContain("With periodId it lists what the pay check lists for that week");
    expect(runChecks.description).toContain("the fuel findings are left out");
    expect(runChecks.description).toContain("get_settlements shows those");
  });
});
