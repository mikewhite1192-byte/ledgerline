import type { Param, Queryable } from "../db";
import type { TenantRows } from "./rows";
import {
  APP_KEEPS_TABLES,
  assertIdentifier,
  TABLE_SPECS,
  TENANT_TABLES,
  type ColumnKind,
  type TenantTable,
} from "./tables";

// Bulk writes for the seed, always inside withTenant. Every statement names its tenant: inserts
// write tenant_id = current_tenant_id() and deletes are bounded by it, so even a login that
// bypasses row-level security (a cluster admin) touches one tenant only.
//
// Inserts go in batches: at most 100 rows and 1,500 parameters per statement, and the SQL plus
// its parameter text stays under the Data API's 65,536 characters. Ids come from the plan (the
// Data API returns no rows for INSERT ... RETURNING), and each statement must report every row
// it was given as inserted.

export const MAX_ROWS_PER_INSERT = 100;
export const MAX_PARAMS_PER_INSERT = 1500;
export const MAX_STATEMENT_CHARS = 65536;

const CAST_KINDS = new Set<ColumnKind>(["uuid", "date", "timestamptz", "jsonb"]);

function placeholder(n: number, kind: ColumnKind): string {
  return CAST_KINDS.has(kind) ? `CAST($${n} AS ${kind})` : `$${n}`;
}

function paramOf(value: unknown, kind: ColumnKind, where: string): Param {
  if (value === undefined) throw new Error(`${where} is missing`);
  if (value === null) return null;
  if (kind === "jsonb") return JSON.stringify(value);
  if (kind === "int") {
    if (!Number.isSafeInteger(value)) throw new Error(`${where} is not a safe integer`);
    return value as number;
  }
  if (kind === "bool") {
    if (typeof value !== "boolean") throw new Error(`${where} is not a boolean`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${where} is not text`);
  return value;
}

const paramChars = (p: Param) => (p === null ? 4 : String(p).length);

export type InsertStatement = { sql: string; params: Param[]; rows: number };

// The statements that insert these rows, in order. Pure, so the batching is tested without a
// database.
export function insertStatements(
  table: TenantTable,
  rows: readonly Record<string, unknown>[],
): InsertStatement[] {
  const { columns } = TABLE_SPECS[table];
  const names = ["tenant_id", ...columns.map(([name]) => assertIdentifier(name))].join(", ");
  const head = `INSERT INTO ${assertIdentifier(table)} (${names}) VALUES `;
  const perRow = Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_PARAMS_PER_INSERT / columns.length));
  const out: InsertStatement[] = [];
  let tuples: string[] = [];
  let params: Param[] = [];
  let chars = head.length;
  const flush = () => {
    if (tuples.length === 0) return;
    out.push({ sql: head + tuples.join(", "), params, rows: tuples.length });
    tuples = [];
    params = [];
    chars = head.length;
  };
  rows.forEach((row, i) => {
    const values = columns.map(([name, kind]) =>
      paramOf(row[name], kind, `${table}[${i}].${name}`),
    );
    const tupleOf = (start: number) => {
      const marks = columns.map(([, kind], k) => placeholder(start + k, kind));
      return `(current_tenant_id(), ${marks.join(", ")})`;
    };
    const valueChars = values.reduce((n: number, v) => n + paramChars(v), 0);
    const size = (start: number) => tupleOf(start).length + 2 + valueChars;
    if (tuples.length === perRow || chars + size(params.length + 1) > MAX_STATEMENT_CHARS) flush();
    if (head.length + size(1) > MAX_STATEMENT_CHARS) throw new Error(`${table}[${i}] is too large`);
    chars += size(params.length + 1);
    tuples.push(tupleOf(params.length + 1));
    params.push(...values);
  });
  flush();
  return out;
}

// Inserts every row and returns how many went in; any shortfall throws, so the caller's
// transaction rolls back.
export async function insertRows(
  q: Queryable,
  table: TenantTable,
  rows: readonly Record<string, unknown>[],
): Promise<number> {
  let inserted = 0;
  for (const statement of insertStatements(table, rows)) {
    const n = await q.execute(statement.sql, statement.params);
    if (n !== statement.rows) throw new Error(`${table}: inserted ${n} of ${statement.rows} rows`);
    inserted += n;
  }
  return inserted;
}

// Deletes the current tenant's rows from every tenant table, children first. Returns the rows
// deleted per table. A table the app role never deletes from (APP_KEEPS_TABLES) gets no statement
// and reports 0: the admin login clears it before the replace, and its rows go with their drivers.
export async function deleteTenantRows(q: Queryable): Promise<Record<TenantTable, number>> {
  const out = {} as Record<TenantTable, number>;
  for (const table of [...TENANT_TABLES].reverse()) {
    if (APP_KEEPS_TABLES.has(table)) {
      out[table] = 0;
      continue;
    }
    out[table] = await q.execute(
      `DELETE FROM ${assertIdentifier(table)} WHERE tenant_id = current_tenant_id()`,
    );
  }
  return out;
}

// Inserts a whole tenant's rows, parents first. Returns the rows inserted per table.
export async function insertTenantRows(
  q: Queryable,
  rows: TenantRows,
): Promise<Record<TenantTable, number>> {
  const out = {} as Record<TenantTable, number>;
  for (const table of TENANT_TABLES) {
    out[table] = await insertRows(q, table, rows[table] as readonly Record<string, unknown>[]);
  }
  return out;
}
