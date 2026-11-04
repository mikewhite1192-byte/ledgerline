import { describe, expect, it } from "vitest";
import type { CarrierPlan } from "../../../seed/plan";
import { callTool } from "../index";
import { ALWAYS_LOADED } from "../loading";
import { redactArgs } from "../redact";
import { REDACT_ENUMS } from "../registry";
import { containsPattern, FIND_DRIVER_CAP, FIND_DRIVER_SQL, findDriver } from "../tools/read/find-driver";
import { parseArgs } from "../validate";
import { context, fixedClock, TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// find_driver: a question that names a driver ("Did Marcus Calloway get the same $200 advance
// twice?") finds the driver's id in one read, in the first response, so the turn's clock is left
// for the reads that take the id. Production, Nov 4: with no such read the turn learned the id
// from a report and ran out of clock before answering.

const plan = blueRidgePlan();
type Found = { driverId: string; code: string; name: string; status: string };
const run = async (name: string, p: CarrierPlan = plan) =>
  (await planDb(p).withTenant(TENANT, (q) => findDriver.run(q, context(), { name }, { screen: null, limit: null })))
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

  it("puts an exact code, then an exact full name, ahead of a full page of partial matches", async () => {
    const monique = row("BR-D07");
    // Eleven more drivers whose codes and names contain hers and whose last names sort first.
    const extra = Array.from({ length: FIND_DRIVER_CAP + 1 }, (_, i) => ({
      ...monique,
      id: `00000000-0000-4000-8000-0000000000${String(10 + i)}`,
      code: `BR-D07${String.fromCharCode(65 + i)}`,
      first_name: `${monique.first_name}${String.fromCharCode(65 + i)}`,
      last_name: `Aa${monique.last_name}`,
    }));
    const crowded: CarrierPlan = { ...plan, rows: { ...plan.rows, drivers: [...plan.rows.drivers, ...extra] } };
    const byCode = await run("br-d07", crowded);
    expect(byCode.drivers).toHaveLength(FIND_DRIVER_CAP);
    expect(byCode.drivers[0].driverId).toBe(monique.id);
    expect(byCode.more).toBe(true);
    const byName = await run(`${monique.first_name} ${monique.last_name}`.toLowerCase(), crowded);
    expect(byName.drivers[0].driverId).toBe(monique.id);
    // The order is in the statement, by parameter, never by text spliced into it.
    expect(FIND_DRIVER_SQL).toContain("ORDER BY (lower(code) = lower(CAST($2 AS text))) DESC");
    expect(FIND_DRIVER_SQL).toContain("(lower(first_name || ' ' || last_name) = lower(CAST($2 AS text))) DESC");
  });

  it("says inactive for a driver not active today, a start still ahead or an end passed", async () => {
    const d = row("BR-D17");
    // The fake clock's day, in the carrier's zone.
    const today = "2026-10-24";
    const at = (active_from: string, active_to: string | null) =>
      run(d.code, { ...plan, rows: { ...plan.rows, drivers: [{ ...d, active_from, active_to }] } });
    expect((await at("2026-10-25", null)).drivers[0].status).toBe("inactive");
    expect((await at("2025-01-01", "2026-10-01")).drivers[0].status).toBe("inactive");
    expect((await at("2025-01-01", today)).drivers[0].status).toBe("active");
    expect(findDriver.description).toContain("inactive when they are not active today: a start date still ahead, or an end date passed");
  });

  it("logs the name it was asked as its length only, even when it reads as a date or an enum value", async () => {
    expect(findDriver.freeTextArgs).toEqual(["name"]);
    // Each would pass the global exemptions as it stands.
    expect(REDACT_ENUMS.has("eligible") && REDACT_ENUMS.has("driver_asked")).toBe(true);
    expect(redactArgs({ name: "2026-10-24" }, REDACT_ENUMS)).toEqual({ name: "2026-10-24" });
    for (const name of ["2026-10-24", "eligible", "driver_asked"]) {
      const db = planDb(plan);
      const out = await callTool(
        context({ role: "operator" }),
        { id: "c", name: "find_driver", argumentsJson: JSON.stringify({ name }) },
        { db, clock: fixedClock },
      );
      expect(out).toMatchObject({ decision: "allowed", tool: "find_driver" });
      expect(db.decisions).toHaveLength(1);
      expect(db.decisions[0].argsRedacted).toEqual({ name: { len: name.length } });
      expect(JSON.stringify(db.decisions[0].argsRedacted)).not.toContain(name);
    }
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
