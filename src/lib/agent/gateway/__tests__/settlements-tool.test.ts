import { describe, expect, it } from "vitest";
import { getSettlements } from "../tools/read/get-settlements";
import { context, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// get_settlements on a week no one has run yet: the open week holds no paystubs until a person
// presses Run the week, and the result says so instead of reading as a week with none due.

const plan = blueRidgePlan();
const run = (args: { periodId?: string }) =>
  planDb(plan).withTenant(TENANT, (q) => getSettlements.run(q, context(), args, { screen: null, limit: null }));

describe("get_settlements", () => {
  it("says the open week has not been run yet when it has no paystubs", async () => {
    const open = plan.rows.settlement_periods.find((p) => p.status === "open")!;
    const out = (await run({ periodId: open.id })).result as Record<string, unknown>;
    expect(out.settlements).toEqual([]);
    expect(out.notRunYet).toBe(true);
  });

  it("never says so for a week that has paystubs", async () => {
    const paid = plan.rows.settlement_periods.find((p) => p.status === "paid")!;
    const out = (await run({ periodId: paid.id })).result as Record<string, unknown>;
    expect((out.settlements as unknown[]).length).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("notRunYet");
  });
});
