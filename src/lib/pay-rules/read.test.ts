import { describe, expect, it } from "vitest";
import { DbError, type Queryable } from "../db";
import { readNextWeekStart } from "./read";
import { rowsFor, TENANT_ID } from "./__tests__/rows";

// The first week a change may start, as Home reads it for the chip: null only when the rules hold
// no week; a failed read throws, so Home shows its unreadable state instead of hiding the failure.

const NOW = new Date("2026-10-27T15:00:00Z");
const TENANT = { id: TENANT_ID, slug: "blue-ridge", name: "Blue Ridge", timezone: "America/New_York" };

function db(versions: () => unknown[]): Queryable {
  return {
    query: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("FROM tenants")) return [TENANT] as T[];
      if (sql.includes("FROM pay_configs")) return versions() as T[];
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
