import { isUuid } from "../uuid";

// One interface, two drivers (the Data API in production, pg locally and in CI), identical SQL.
// App SQL uses positional $1, $2 parameters and CAST($1 AS uuid) where a column is not text
// (not the :: shorthand until the Data API is shown to pass it through untouched).

// Money is integer cents, so numbers must be safe integers; dates travel as ISO strings with a
// CAST to timestamptz in the SQL.
export type Param = string | number | boolean | null;

export interface Queryable {
  query<T>(sql: string, params?: Param[]): Promise<T[]>;
  // Rows affected.
  execute(sql: string, params?: Param[]): Promise<number>;
}

// What the app gets: every query runs in a transaction that first sets app.tenant_id.
export interface TenantDb {
  withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
}

// Scripts and tests only (migrations, demo users, the fail-closed tests). Not reachable through
// src/lib/db/index.ts.
export interface Db extends TenantDb {
  withoutTenant<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbErrorCategory =
  | "resuming"
  | "unavailable"
  | "timeout"
  | "rls_denied"
  | "sql"
  | "unknown"
  | "not_configured";

// Carries a category and, when the database gave one, its SQLSTATE. Never the SQL text, the
// parameters or the upstream message: those can hold personal data.
export class DbError extends Error {
  readonly category: DbErrorCategory;
  readonly sqlState?: string;

  constructor(category: DbErrorCategory, sqlState?: string) {
    super(sqlState ? `database error: ${category} (${sqlState})` : `database error: ${category}`);
    this.name = "DbError";
    this.category = category;
    this.sqlState = sqlState;
  }
}

// Any error from COMMIT itself. The database may have committed before the reply was lost, so
// the outcome is unknown whatever the error says (a timeout or an outage here is not "nothing
// ran", and never a reason to retry). The SQLSTATE stays when the database gave one.
export function commitFailed(err: unknown): DbError {
  return new DbError("unknown", err instanceof DbError ? err.sqlState : undefined);
}

// 42501 is insufficient_privilege: a row-level security refusal or a missing grant.
export function categoryForSqlState(sqlState: string): DbErrorCategory {
  if (sqlState === "42501") return "rls_denied";
  if (sqlState === "57014") return "timeout";
  if (sqlState.startsWith("08")) return "unavailable";
  return "sql";
}

export function assertTenantId(tenantId: string): void {
  if (!isUuid(tenantId)) throw new Error("tenant id is not a UUID");
}

// The statement every tenant transaction runs first. true = transaction-local: the setting
// reverts at commit or rollback, so it never outlives the request on a reused connection.
export const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";

// Runs fn with a handle that works only while fn runs. Kept past that, it would run outside its
// transaction (with pg, on a pooled client that may hold no tenant or another request's
// transaction), so once fn returns or throws every call throws before any SQL is sent. The
// category is sql: a caller's mistake, not an outage, and not an unknown outcome.
export async function withScopedHandle<T>(
  q: Queryable,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  let open = true;
  const scoped: Queryable = {
    async query<R>(sql: string, params?: Param[]) {
      if (!open) throw new DbError("sql");
      return q.query<R>(sql, params);
    },
    async execute(sql: string, params?: Param[]) {
      if (!open) throw new DbError("sql");
      return q.execute(sql, params);
    },
  };
  try {
    return await fn(scoped);
  } finally {
    open = false;
  }
}
