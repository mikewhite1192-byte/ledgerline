import { describe, expect, it } from "vitest";
import { ALWAYS_LOADED } from "../loading";
import { containsPattern, FIND_DRIVER_CAP, findDriver } from "../tools/read/find-driver";
import { parseArgs } from "../validate";
import { context, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// find_driver: a question that names a driver ("Did Marcus Calloway get the same $200 advance
// twice?") finds the driver's id in one read, in the first response, so the turn's clock is left
// for the reads that take the id. Production, Nov 4: with no such read the turn learned the id
// from a report and ran out of clock before answering.

const plan = blueRidgePlan();
type Found = { driverId: string; code: string; name: string; status: string };
const run = async (name: string) =>
  (await planDb(plan).withTenant(TENANT, (q) => findDriver.run(q, context(), { name }, { screen: null, limit: null })))
    .result as { drivers: Found[]; more: boolean };
const row = (code: string) => plan.rows.drivers.find((d) => d.code === code)!;

describe("find_driver", () => {
  it("finds a driver by last name, with the id the other reads take", async () => {
    const marcus = row("BR-D17");
    const out = await run(marcus.last_name);
    expect(out.drivers).toContainEqual({
      driverId: marcus.id,
      code: "BR-D17",
      name: `${marcus.first_name} ${marcus.last_name}`,
      status: "active",
    });
    expect(out.more).toBe(false);
  });

  it("finds a driver by code and by full name, ignoring case", async () => {
    const monique = row("BR-D07");
    expect((await run("br-d07")).drivers.map((d) => d.driverId)).toEqual([monique.id]);
    const full = `${monique.first_name} ${monique.last_name}`.toUpperCase();
    expect((await run(full)).drivers.map((d) => d.driverId)).toEqual([monique.id]);
    expect((await run("zzqx")).drivers).toEqual([]);
  });

  it("returns at most the cap, by last name, and says more matched", async () => {
    const out = await run("BR-D");
    expect(FIND_DRIVER_CAP).toBe(10);
    expect(out.drivers).toHaveLength(FIND_DRIVER_CAP);
    expect(out.more).toBe(plan.rows.drivers.length > FIND_DRIVER_CAP);
    const last = out.drivers.map((d) => d.name.split(" ").slice(-1)[0]);
    expect([...last].sort()).toEqual(last);
  });

  it("takes a short trimmed name only, and matches LIKE wildcards as themselves", () => {
    const parse = (args: unknown) => parseArgs(findDriver.args, JSON.stringify(args));
    expect(parse({ name: "  Calloway " })).toEqual({ ok: true, args: { name: "Calloway" } });
    for (const bad of [{ name: "a" }, { name: " " }, { name: "x".repeat(61) }, { name: "ab\ncd" }, {}, { name: "ab", x: 1 }]) {
      expect(parse(bad).ok).toBe(false);
    }
    expect(containsPattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });

  it("is loaded on every call and points the id at the reads that take it", () => {
    expect(ALWAYS_LOADED).toContain("find_driver");
    expect(findDriver.refs({ name: "Marcus" })).toEqual([]);
    expect(findDriver.description).toContain("A question that names a driver starts here, in the same response as set_checklist");
    expect(findDriver.description).toContain("get_advances, explain_paystub, get_driver");
    expect(findDriver.description).not.toMatch(/[\u2013\u2014]/);
  });
});
