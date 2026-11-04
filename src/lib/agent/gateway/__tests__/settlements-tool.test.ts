import { describe, expect, it } from "vitest";
import { getSettlements } from "../tools/read/get-settlements";
import { context, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// get_settlements on an open week with no paystubs: the result says only that none exist yet (the
// week records no run, so it never claims the week was not run).

const plan = blueRidgePlan();
const run = (args: { periodId?: string }) =>
  planDb(plan).withTenant(TENANT, (q) => getSettlements.run(q, context(), args, { screen: null, limit: null }));

describe("get_settlements", () => {
  it("says the open week has no paystubs yet when it has none", async () => {
    const open = plan.rows.settlement_periods.find((p) => p.status === "open")!;
    const out = (await run({ periodId: open.id })).result as Record<string, unknown>;
    expect(out.settlements).toEqual([]);
    expect(out.noPaystubsYet).toBe(true);
    expect(out).not.toHaveProperty("notRunYet");
  });

  it("never says so for a week that has paystubs", async () => {
    const paid = plan.rows.settlement_periods.find((p) => p.status === "paid")!;
    const out = (await run({ periodId: paid.id })).result as Record<string, unknown>;
    expect((out.settlements as unknown[]).length).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("noPaystubsYet");
  });

  it("never claims the week was not run", () => {
    expect(getSettlements.description).toContain("never say it was not run");
    expect(getSettlements.description).not.toMatch(/means the week has not been run/);
  });
});
