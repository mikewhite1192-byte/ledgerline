import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgDb } from "./pg";
import { adminUrl, appUrl } from "./test-urls";
import { DbError, type Db, type Queryable } from "./types";

// The pg driver's transactions against a real database. Once the callback has returned, its
// connection is back in the pool, so a kept handle must never reach it again; and a COMMIT that
// fails is an unknown outcome, not a SQL error.

let app: Db;

describe("pg driver", () => {
  beforeAll(() => {
    // One connection, so a stale call would land on the client the next transaction uses.
    app = createPgDb({ connectionString: appUrl(), max: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("refuses a handle kept past its transaction and sends nothing", async () => {
    const tenant = randomUUID();
    const kept: Queryable[] = [];
    await app.withTenant(tenant, async (q) => {
      kept.push(q);
      return q.query("SELECT 1 AS ok");
    });
    await expect(
      app.withTenant(tenant, async (q) => {
        kept.push(q);
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    const sent = vi.spyOn(pg.Client.prototype, "query");
    for (const q of kept) {
      await expect(q.query("SELECT 1 AS ok")).rejects.toMatchObject({ category: "sql" });
      await expect(q.execute("SELECT 1")).rejects.toBeInstanceOf(DbError);
    }
    expect(sent).not.toHaveBeenCalled();

    // The connection still serves the next transaction, and the spy sees its SQL.
    const rows = await app.withTenant(tenant, (q) => q.query<{ ok: number }>("SELECT 1 AS ok"));
    expect(rows).toEqual([{ ok: 1 }]);
    expect(sent).toHaveBeenCalled();
  });

  it("reports a commit that failed as unknown, keeping its SQLSTATE", async () => {
    // A deferred unique check runs at COMMIT, so COMMIT itself fails (23505). The admin login
    // makes the temp table: this tests the driver, not the app's grants.
    const admin = createPgDb({ connectionString: adminUrl(), max: 1 });
    try {
      const err = await admin
        .withoutTenant(async (q) => {
          await q.execute(
            "CREATE TEMP TABLE commit_probe (id int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP",
          );
          await q.execute("INSERT INTO commit_probe VALUES (1), (1)");
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DbError);
      expect(err).toMatchObject({ category: "unknown", sqlState: "23505" });

      // The ROLLBACK that follows leaves the connection usable for the next transaction.
      const rows = await admin.withoutTenant((q) => q.query<{ ok: number }>("SELECT 1 AS ok"));
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await admin.close();
    }
  });
});
