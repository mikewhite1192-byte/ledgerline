import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgDb } from "./pg";
import { appUrl } from "./test-urls";
import { DbError, type Db, type Queryable } from "./types";

// The pg driver's transaction handle against a real database: once the callback has returned,
// its connection is back in the pool, so a kept handle must never reach it again.

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
});
