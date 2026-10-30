import type { Pool, PoolClient, QueryConfig } from "pg";
import {
  assertTenantId,
  categoryForSqlState,
  commitFailed,
  DbError,
  SET_TENANT_SQL,
  withScopedHandle,
  type Db,
  type Param,
  type Queryable,
} from "./types";

// Local and CI only (production never talks to a DATABASE_URL). pg loads lazily so the
// production bundle never runs it, and next.config.ts keeps the bundler away from it.
export type PgConfig = { connectionString: string; max?: number };

type PgTypes = typeof import("pg").types;

let parsersInstalled = false;

// Make pg return what the Data API's JSON returns: bigint cents as numbers (refused past 2^53),
// and dates and timestamps as strings, never Date objects.
function installTypeParsers(types: PgTypes): void {
  if (parsersInstalled) return;
  types.setTypeParser(20, (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error("bigint value is not a safe integer");
    return n;
  });
  for (const oid of [1082, 1114, 1184]) types.setTypeParser(oid, (value: string) => value);
  parsersInstalled = true;
}

export function createPgDb(config: PgConfig): Db {
  let poolPromise: Promise<Pool> | undefined;

  function pool(): Promise<Pool> {
    poolPromise ??= (async () => {
      const { Pool: PgPool, types } = await import("pg");
      installTypeParsers(types);
      const p = new PgPool({ connectionString: config.connectionString, max: config.max });
      p.on("error", () => console.error("db: idle connection error"));
      return p;
    })();
    return poolPromise;
  }

  function queryable(client: PoolClient): Queryable {
    async function run(sql: string, params?: Param[]) {
      // Extended protocol, like the Data API: one statement per call, never a batch.
      const query = { text: sql, values: params ?? [], queryMode: "extended" };
      try {
        return await client.query(query as QueryConfig);
      } catch (err) {
        throw toDbError(err);
      }
    }
    return {
      async query<T>(sql: string, params?: Param[]) {
        return (await run(sql, params)).rows as T[];
      },
      async execute(sql: string, params?: Param[]) {
        return (await run(sql, params)).rowCount ?? 0;
      },
    };
  }

  async function inTransaction<T>(
    tenantId: string | null,
    fn: (q: Queryable) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await (await pool()).connect();
    } catch (err) {
      throw toDbError(err);
    }
    const q = queryable(client);
    let broken = false;
    try {
      await q.execute("BEGIN");
      if (tenantId !== null) await q.query(SET_TENANT_SQL, [tenantId]);
      const result = await withScopedHandle(q, fn);
      // A commit that failed has an unknown outcome, so it surfaces as unknown.
      try {
        await q.execute("COMMIT");
      } catch (err) {
        throw commitFailed(err);
      }
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      // A connection whose rollback failed is destroyed, never reused: it could still be inside
      // the transaction that holds the tenant setting.
      client.release(broken);
    }
  }

  return {
    async withTenant(tenantId, fn) {
      assertTenantId(tenantId);
      return inTransaction(tenantId, fn);
    },
    async withoutTenant(fn) {
      return inTransaction(null, fn);
    },
    async close() {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}

function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    // node-postgres names the broken constraint in its own field; the message text is never read.
    const constraint = (err as { constraint?: unknown }).constraint;
    return new DbError(categoryForSqlState(code), code, typeof constraint === "string" ? constraint : undefined);
  }
  // Node socket errors (ECONNREFUSED, ENOENT on a socket path) mean the database is unreachable.
  if (typeof code === "string" && code.startsWith("E")) return new DbError("unavailable");
  return new DbError("unknown");
}
