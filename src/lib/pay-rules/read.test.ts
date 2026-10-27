import { describe, expect, it } from "vitest";
import { DbError, type Queryable } from "../db";
import { readNextWeekStart, readPayRulesPage } from "./read";
import { rowsFor, TENANT_ID, versionFrom } from "./__tests__/rows";

// The first week a change may start, as Home reads it for the chip: null only when the rules hold
// no week; a failed read throws, so Home shows its unreadable state instead of hiding the failure.

const NOW = new Date("2026-10-27T15:00:00Z");
const TENANT = { id: TENANT_ID, slug: "blue-ridge", name: "Blue Ridge", timezone: "America/New_York" };

function db(versions: () => unknown[]): Queryable {
  return {
    query: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("FROM tenants")) return [TENANT] as T[];
      if (sql.includes("FROM pay_configs")) return versions() as T[];
      if (sql.includes("FROM settlements")) return [] as T[];
      if (sql.includes("FROM memberships")) return [{ role: "admin" }] as T[];
      throw new Error("unexpected statement");
    },
    execute: async () => {
      throw new Error("unexpected write");
    },
  };
}

describe("readNextWeekStart", () => {
  it("is the week after the one that holds now", async () => {
    const versions = rowsFor("blue-ridge").pay_configs;
    await expect(readNextWeekStart(db(() => versions), NOW)).resolves.toBe("2026-11-02");
  });

  it("is null when the rules hold no week", async () => {
    await expect(readNextWeekStart(db(() => []), NOW)).resolves.toBeNull();
  });

  it("throws a failed read of the rules instead of answering null", async () => {
    const failed = new DbError("unavailable");
    await expect(
      readNextWeekStart(
        db(() => {
          throw failed;
        }),
        NOW,
      ),
    ).rejects.toBe(failed);
  });
});

describe("readPayRulesPage", () => {
  it("dates each version by the first pay week it runs, so one saved midweek starts the next Monday", async () => {
    // Blue Ridge weeks start Monday. A version saved for Wednesday Oct 28 first runs the week of
    // Nov 2, the week the engine picks it for; the seeded versions start on their own Mondays.
    const rows = rowsFor("blue-ridge");
    const midweek = versionFrom(rows, "midweek", "2026-10-28");
    const page = await readPayRulesPage(db(() => [...rows.pay_configs, midweek]), "sub", NOW);
    const firstWeeks = page.versions.map((v) => [v.effective_from, v.firstWeek]);
    expect(firstWeeks).toEqual([
      ["2026-10-05", "2026-10-05"],
      ["2026-10-19", "2026-10-19"],
      ["2026-10-28", "2026-11-02"],
    ]);
    // This week (Oct 26) still runs under the Oct 19 version.
    expect(page.currentId).toBe(rows.pay_configs.find((v) => v.effective_from === "2026-10-19")?.id);
  });

  it("marks a version that a later one replaced before its first week as never run", async () => {
    const rows = rowsFor("blue-ridge");
    const wednesday = versionFrom(rows, "wednesday", "2026-10-28");
    const friday = versionFrom(rows, "friday", "2026-10-30");
    const page = await readPayRulesPage(db(() => [...rows.pay_configs, wednesday, friday]), "sub", NOW);
    expect(page.versions.find((v) => v.id === "wednesday")?.firstWeek).toBeNull();
    expect(page.versions.find((v) => v.id === "friday")?.firstWeek).toBe("2026-11-02");
  });
});
