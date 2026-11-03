import { describe, expect, it } from "vitest";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { DEMO_CARRIERS } from "../seed/carriers";
import { countRows } from "../seed/summary";
import {
  CopyBuildFailed,
  buildStatements,
  copyPlan,
  copySlug,
  pendingTables,
  sliceCount,
  sliceOf,
  templatePlan,
  type TableStep,
} from "./build";
import { VISIT_EMAIL, isVisitor } from "./visitor";

const COPY = "0a1b2c3d-9e8f-4000-8000-000000000001";
const empty = () => Object.fromEntries(TENANT_TABLES.map((t) => [t, 0])) as Record<TenantTable, number>;
const step = (table: TenantTable, statements: number): TableStep => ({ table, rows: statements * 100, statements });

describe("copySlug", () => {
  it("is the template's slug, -v- and the copy id's first eight hex digits, inside the tenants CHECK", () => {
    for (const c of DEMO_CARRIERS) {
      const slug = copySlug(c, COPY.toUpperCase());
      expect(slug).toBe(`${c.slug}-v-0a1b2c3d`);
      expect(slug).toMatch(/^[a-z0-9-]{3,40}$/);
    }
    expect(() => copySlug(DEMO_CARRIERS[0], "nope")).toThrow(CopyBuildFailed);
  });
});

describe("the visitor's email", () => {
  it("is never a real address, and only it reads as the visitor", () => {
    expect(VISIT_EMAIL.endsWith(".invalid")).toBe(true);
    expect(isVisitor({ email: VISIT_EMAIL })).toBe(true);
    expect(isVisitor({ email: "ops@blue-ridge.example" })).toBe(false);
  });
});

describe("pendingTables", () => {
  const plan = templatePlan(DEMO_CARRIERS[0]);
  const want = countRows(plan.rows);

  it("lists every table with rows on an empty copy, in TENANT_TABLES order, and nothing once all counts match", () => {
    const all = pendingTables(empty(), plan);
    const withRows = TENANT_TABLES.filter((t) => want[t] > 0);
    expect(all.map((s) => s.table)).toEqual(withRows);
    for (const s of all) {
      expect(s.rows).toBe(want[s.table]);
      expect(s.statements).toBeGreaterThan(0);
    }
    expect(pendingTables({ ...want }, plan)).toEqual([]);
  });

  it("skips a table already whole and refuses one that holds rows this build did not write", () => {
    const first = pendingTables(empty(), plan)[0];
    const have = { ...empty(), [first.table]: want[first.table] };
    expect(pendingTables(have, plan).map((s) => s.table)).not.toContain(first.table);
    expect(() => pendingTables({ ...empty(), [first.table]: 1 }, plan)).toThrow(CopyBuildFailed);
    expect(() => pendingTables({ ...empty(), [first.table]: want[first.table] + 1 }, plan)).toThrow(CopyBuildFailed);
  });

  it("is the same list for a copy's remapped plan", () => {
    const tables = (p: typeof plan) => pendingTables(empty(), p).map((s) => [s.table, s.rows, s.statements]);
    expect(tables(copyPlan(DEMO_CARRIERS[0], COPY))).toEqual(tables(plan));
  });
});

describe("sliceOf", () => {
  const pending = [step("drivers", 4), step("loads", 6), step("settlements", 2)];

  it("takes tables while the slice has time, the one that crosses it included", () => {
    // 10 ms a statement, 50 ms: drivers (40) then loads (60, crossing), then stop.
    expect(sliceOf(pending, 10, 50).map((s) => s.table)).toEqual(["drivers", "loads"]);
    expect(sliceOf(pending, 10, 1_000).map((s) => s.table)).toEqual(["drivers", "loads", "settlements"]);
  });

  it("always takes at least one table, so every slice moves the build on", () => {
    expect(sliceOf(pending, 1_000, 1).map((s) => s.table)).toEqual(["drivers"]);
    expect(sliceOf([], 10, 50)).toEqual([]);
  });
});

describe("sliceCount and buildStatements", () => {
  it("measures each demo carrier's build: statements and slices at 50 and 150 ms a statement", () => {
    for (const c of DEMO_CARRIERS) {
      const plan = templatePlan(c);
      const statements = buildStatements(plan);
      const inserts = pendingTables(empty(), plan).reduce((n, s) => n + s.statements, 0);
      expect(statements).toBeGreaterThan(inserts);
      const fast = sliceCount(plan, 50, 12_000);
      const slow = sliceCount(plan, 150, 12_000);
      expect(fast).toBeGreaterThanOrEqual(1);
      expect(slow).toBeGreaterThanOrEqual(fast);
      // Every table in its own slice is the most there can be.
      expect(slow).toBeLessThanOrEqual(pendingTables(empty(), plan).length);
      console.info(`visit copy plan ${c.slug}: ${statements} statements, ${fast} slices at 50 ms, ${slow} at 150 ms`);
    }
  });
});
