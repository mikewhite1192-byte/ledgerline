import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { checkInputOf } from "../../../data/records";
import { runFuelChecks } from "../../../rules-engine/fuel";
import { instantAt } from "../../../seed/calendar";
import { callTool } from "../index";
import type { GatewayContext } from "../types";
import { context, fixedClock, TENANT, type Handler } from "./fake-db";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "./plan-db";

// run_checks over the synthetic Blue Ridge plan: the fuel checks join its list only while their
// switch is on and only for a demo carrier, since their start date is the demo weeks'. Any other
// carrier gets the pay and receivables checks alone. No database, no clock, no network.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(PLAN_ANCHOR, 12, 0, zone)), timeZone: zone });
const call = { id: "call-1", name: "run_checks", argumentsJson: "{}" };
const FUEL_CHECKS = new Set(["fuel_off_route", "fuel_over_tank", "fuel_while_parked", "fuel_duplicate"]);
const TENANT_SQL = "SELECT id, slug, name, timezone FROM tenants WHERE id = current_tenant_id()";

const shipped = structuredClone(flags);

afterEach(() => {
  Object.assign(flags, structuredClone(shipped));
});

async function fuelRows(extra?: Handler): Promise<{ check: string; suggestedCents?: number | null }[]> {
  const out = await callTool(ctx, call, { db: planDb(plan, extra), clock: fixedClock });
  if (out.decision !== "allowed") throw new Error("not allowed");
  const rows = (out.result as { rows: { check: string; suggestedCents?: number | null }[] }).rows;
  return rows.filter((r) => FUEL_CHECKS.has(r.check));
}

describe("run_checks and the fuel checks", () => {
  it("lists the engine's fuel findings for a demo carrier while the switch is on", async () => {
    flags.fuelAnomalyEnabled = true;
    const want = runFuelChecks(checkInputOf(plan.rows), flags.fuelAnomalyLimits);
    expect(want.length).toBeGreaterThan(0);
    const rows = await fuelRows();
    expect(rows.map((r) => [r.check, r.suggestedCents])).toEqual(want.map((f) => [f.check, f.suggestedCents]));
  });

  it("leaves the fuel findings out while the switch is off", async () => {
    flags.fuelAnomalyEnabled = false;
    expect(await fuelRows()).toEqual([]);
  });

  it("leaves the fuel findings out for any carrier that is not a demo carrier, switch on", async () => {
    flags.fuelAnomalyEnabled = true;
    const c = plan.carrier;
    for (const row of [
      { id: TENANT, slug: "other-freight", name: "Other Freight", timezone: c.timezone },
      // A carrier that only took a demo slug is not that carrier.
      { id: TENANT, slug: c.slug, name: "Other Freight", timezone: c.timezone },
    ]) {
      const asOther: Handler = (sql) => (sql === TENANT_SQL ? [row] : undefined);
      expect(await fuelRows(asOther)).toEqual([]);
    }
  });
});
