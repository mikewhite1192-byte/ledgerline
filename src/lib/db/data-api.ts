import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { toDataApiParams } from "./params";
import {
  assertTenantId,
  categoryForSqlState,
  commitFailed,
  DbError,
  SET_TENANT_SQL,
  withScopedHandle,
  type Db,
  type DbErrorCategory,
  type Param,
  type Queryable,
} from "./types";

export type DataApiConfig = {
  clusterArn: string;
  secretArn: string;
  database: string;
  region: string;
  // Migrations only: DDL keeps running if the 45-second call limit passes.
  continueAfterTimeout?: boolean;
};

// Tests pass a fake client and a no-op sleep.
export type DataApiDeps = {
  client?: RDSDataClient;
  sleep?: (ms: number) => Promise<void>;
};

// A paused cluster answers BeginTransaction with DatabaseResumingException and wakes in about
// 15 seconds. Retrying is safe only here, before a transaction exists: 5 tries, 5 seconds apart.
export const BEGIN_ATTEMPTS = 5;
export const BEGIN_DELAY_MS = 5_000;

export function createDataApiDb(config: DataApiConfig, deps: DataApiDeps = {}): Db {
  const client = deps.client ?? new RDSDataClient({ region: config.region });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const target = { resourceArn: config.clusterArn, secretArn: config.secretArn };

  async function begin(): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await call(() =>
          client.send(new BeginTransactionCommand({ ...target, database: config.database })),
        );
        if (!out.transactionId) throw new DbError("unknown");
        return out.transactionId;
      } catch (err) {
        const waking =
          err instanceof DbError && (err.category === "resuming" || err.category === "unavailable");
        if (!waking || attempt >= BEGIN_ATTEMPTS) throw err;
        await sleep(BEGIN_DELAY_MS);
      }
    }
  }

  function queryable(transactionId: string): Queryable {
    async function run(sql: string, params?: Param[]) {
      // No parameters: the SQL goes as written, so a migration's $$ or $1 bodies survive.
      const statement = params && params.length > 0 ? toDataApiParams(sql, params) : { sql };
      return call(() =>
        client.send(
          new ExecuteStatementCommand({
            ...target,
            database: config.database,
            transactionId,
            formatRecordsAs: "JSON",
            continueAfterTimeout: config.continueAfterTimeout,
            ...statement,
          }),
        ),
      );
    }
    return {
      async query<T>(sql: string, params?: Param[]) {
        const out = await run(sql, params);
        return out.formattedRecords ? (JSON.parse(out.formattedRecords) as T[]) : [];
      },
      async execute(sql: string, params?: Param[]) {
        const out = await run(sql, params);
        return out.numberOfRecordsUpdated ?? 0;
      },
    };
  }

  // Any error after BeginTransaction is a rollback and a rethrow, never a retry: the transaction
  // may already be gone. A commit that failed has an unknown outcome, so it surfaces as unknown.
  async function inTransaction<T>(
    tenantId: string | null,
    fn: (q: Queryable) => Promise<T>,
  ): Promise<T> {
    const transactionId = await begin();
    const q = queryable(transactionId);
    try {
      if (tenantId !== null) await q.query(SET_TENANT_SQL, [tenantId]);
      const result = await withScopedHandle(q, fn);
      try {
        await call(() => client.send(new CommitTransactionCommand({ ...target, transactionId })));
      } catch (err) {
        throw commitFailed(err);
      }
      return result;
    } catch (err) {
      try {
        await call(() => client.send(new RollbackTransactionCommand({ ...target, transactionId })));
      } catch {
        // Already logged by category; the original error is the one that matters.
      }
      throw err;
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
      client.destroy();
    },
  };
}

// Every SDK failure becomes a DbError. The log line carries the category, the SDK error name and
// the SQLSTATE, never the SQL parameters or the upstream message.
async function call<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    const name = err instanceof Error ? err.name : "non-error";
    const sqlState = sqlStateOf(err);
    const category = sqlState ? categoryForSqlState(sqlState) : categoryForName(name);
    console.error(`db: ${category} (${name}${sqlState ? ` ${sqlState}` : ""})`);
    throw new DbError(category, sqlState, constraintOf(err, sqlState));
  }
}

function categoryForName(name: string): DbErrorCategory {
  switch (name) {
    case "DatabaseResumingException":
      return "resuming";
    case "DatabaseUnavailableException":
    case "ServiceUnavailableError":
      return "unavailable";
    case "StatementTimeoutException":
    case "TimeoutError":
      return "timeout";
    case "DatabaseErrorException":
    case "BadRequestException":
      return "sql";
    default:
      return "unknown";
  }
}

// A SQL error comes back as text ending "SQLState: 42501". Only the five-character code is
// read; the rest of the message stays out of logs.
function sqlStateOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.name !== "DatabaseErrorException" && err.name !== "BadRequestException") return undefined;
  return /SQLState: ([0-9A-Z]{5})\b/.exec(err.message)?.[1];
}

// A unique violation (23505) names its constraint in the Postgres text: violates unique
// constraint "<name>". Only that quoted name is read, and only when it is a plain lower-case
// identifier filling the quotes; anything else gives no name. The rest of the message is never
// kept or logged.
function constraintOf(err: unknown, sqlState: string | undefined): string | undefined {
  if (sqlState !== "23505" || !(err instanceof Error)) return undefined;
  return /violates unique constraint "([a-z0-9_]{1,63})"/.exec(err.message)?.[1];
}
