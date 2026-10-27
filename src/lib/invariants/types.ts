import type { Db, Param, Queryable } from "../db/types";

// The money invariants: five read-only checks over every tenant's rows, each one line of
// categories and counts. Unknown is not zero: a read that errors, a value that is not a whole
// number, or a probe with nothing to compare is UNKNOWN, and the run exits non-zero exactly as it
// does on a FAIL. Output never carries a row id, a name, an amount or anything a person typed;
// schema identifiers (a table or index name) are the only names that appear.

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5";

export type InvariantResult = {
  id: InvariantId;
  name: string;
  verdict: Verdict;
  // What was read, by kind: the denominators that show the check saw real rows.
  counts: Record<string, number>;
  // Violations by category, only categories with a count above zero.
  violations: Record<string, number>;
  // What could not be read or decided, by category.
  unknown: string[];
};

export const INVARIANT_NAMES: Record<InvariantId, string> = {
  I1: "ledger",
  I2: "keys",
  I3: "approvals",
  I4: "model calls",
  I5: "row security",
};

// A violation is a FAIL even when another part was unreadable; otherwise anything unreadable is
// UNKNOWN; only a full, clean read is a PASS.
export function verdictOf(violations: Record<string, number>, unknown: string[]): Verdict {
  if (Object.values(violations).some((n) => n > 0)) return "FAIL";
  if (unknown.length > 0) return "UNKNOWN";
  return "PASS";
}

export function resultOf(
  id: InvariantId,
  counts: Record<string, number>,
  violations: Record<string, number>,
  unknown: string[] = [],
): InvariantResult {
  const found: Record<string, number> = {};
  for (const [k, n] of Object.entries(violations)) if (n > 0) found[k] = n;
  const unread = [...new Set(unknown)].sort();
  return { id, name: INVARIANT_NAMES[id], verdict: verdictOf(found, unread), counts, violations: found, unknown: unread };
}

// The result for a check whose read failed before any verdict could be made.
export function unreadable(id: InvariantId, err: unknown): InvariantResult {
  return resultOf(id, {}, {}, [readFailureCategory(err)]);
}

export class InvariantReadError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`invariant read: ${category}`);
    this.name = "InvariantReadError";
    this.category = category;
  }
}

// Categories only: a database error's category and SQLSTATE, never its message.
export function readFailureCategory(err: unknown): string {
  if (err instanceof InvariantReadError) return err.category;
  const e = err as { name?: unknown; category?: unknown; sqlState?: unknown } | null;
  if (e && e.name === "DbError" && typeof e.category === "string") {
    const state = typeof e.sqlState === "string" && /^[0-9A-Z]{5}$/.test(e.sqlState) ? `_${e.sqlState}` : "";
    return `read_failed_${e.category}${state}`;
  }
  return "read_failed";
}

// Adds n to a category, so a verdict function can count as it goes.
export function tally(into: Record<string, number>, category: string, n = 1): void {
  into[category] = (into[category] ?? 0) + n;
}

// A whole number from the driver: pg gives int8 as a number (it refuses an unsafe one) and a
// numeric as a string; the Data API gives JSON numbers. Anything else is unknown, never zero.
export function whole(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?[0-9]{1,16}$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new InvariantReadError("not_whole");
}

export function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new InvariantReadError("not_boolean");
}

// A count from an aggregate: a whole number, never below zero.
export function countOf(value: unknown): number {
  const n = whole(value);
  if (n < 0) throw new InvariantReadError("not_whole");
  return n;
}

// The one row an aggregate returns; none, or more than one, is unread.
export function onlyRow<T>(rows: T[], category: string): T {
  if (rows.length !== 1) throw new InvariantReadError(category);
  return rows[0];
}

// An aggregate's count of rows the per-row read would have refused (a NULL where a number or a
// flag belongs): any at all leaves the whole check unread, as the per-row read did.
export function refuseUnread(count: unknown, category: "not_whole" | "not_boolean"): void {
  if (countOf(count) > 0) throw new InvariantReadError(category);
}

// A schema identifier as it may appear in a category: plain lower-case identifiers only.
export function safeName(name: unknown): string {
  return typeof name === "string" && /^[a-z_][a-z0-9_.]{0,126}$/.test(name) ? name : "unnamed";
}

// ---- Read-only access ----

// The only handle a check gets: query, no execute. Every statement must be one SELECT.
export interface ReadQuery {
  query<T>(sql: string, params?: Param[]): Promise<T[]>;
}

export function isReadSql(sql: string): boolean {
  const text = sql.trim();
  return /^SELECT\s/i.test(text) && !text.includes(";");
}

export function readOnly(q: Queryable): ReadQuery {
  return {
    query<T>(sql: string, params?: Param[]) {
      if (!isReadSql(sql)) return Promise.reject(new InvariantReadError("refused_not_select"));
      return q.query<T>(sql, params);
    },
  };
}

// Each read transaction is also read-only in the database, so a statement that slipped past the
// SELECT rule still could not write. The admin's reads see one snapshot (repeatable read), so
// totals and the rows behind them are read at the same instant; with a tenant set, the tenant
// setting is the transaction's first statement, so only the access mode can change after it
// (Postgres allows switching to read-only at any point).
export const READ_ONLY_SNAPSHOT_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";
export const READ_ONLY_SQL = "SET TRANSACTION READ ONLY";

export function readAll<T>(db: Db, fn: (q: ReadQuery) => Promise<T>): Promise<T> {
  return db.withoutTenant(async (q) => {
    await q.execute(READ_ONLY_SNAPSHOT_SQL);
    return fn(readOnly(q));
  });
}

// ---- Paged reads ----

// One Data API response holds at most 1 MiB, so every check reads aggregates (one row) where SQL
// can judge exactly what TypeScript judged. A read that must return one row per record, because
// its judgment is code the SQL must not copy, reads in pages by key: ordered by (tenant_id, id),
// PAGE_SIZE rows at a time, each page after the last key seen, until a short page. Every page is
// read inside readAll's one snapshot. A paged row is at most about 230 bytes in the Data API's
// encoding (two uuid keys, a status, three numbers), so a page stays near 230 KB, under a quarter
// of the limit. More than MAX_PAGES full pages is unread, never a partial verdict. Fixed
// constants, never input.
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 100;

// first takes the page size as $1; after takes the last page's tenant_id and id as $1 and $2 and
// the page size as $3. Each returns the key as page_tenant and page_id (text).
export type PagedSql = { first: string; after: string };
export type PageKey = { page_tenant: unknown; page_id: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pageKey(value: unknown): string {
  if (typeof value === "string" && UUID.test(value)) return value;
  throw new InvariantReadError("page_key_unread");
}

export async function readPaged<T extends PageKey>(
  q: ReadQuery,
  sql: PagedSql,
  size: number = PAGE_SIZE,
  pages: number = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let after: [string, string] | null = null;
  for (let page = 0; page < pages; page += 1) {
    const rows: T[] =
      after === null ? await q.query<T>(sql.first, [size]) : await q.query<T>(sql.after, [after[0], after[1], size]);
    for (const row of rows) out.push(row);
    if (rows.length < size) return out;
    const last = rows[rows.length - 1];
    after = [pageKey(last.page_tenant), pageKey(last.page_id)];
  }
  throw new InvariantReadError("page_cap");
}

export function readAs<T>(db: Db, tenantId: string | null, fn: (q: ReadQuery) => Promise<T>): Promise<T> {
  const body = async (q: Queryable) => {
    await q.execute(READ_ONLY_SQL);
    return fn(readOnly(q));
  };
  return tenantId === null ? db.withoutTenant(body) : db.withTenant(tenantId, body);
}

// ---- Output ----

function pairs(record: Record<string, number>): string {
  return Object.entries(record)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

// I1 ledger: PASS (settlements 150, payouts 0)
// I1 ledger: FAIL (settlement_totals_off 1; settlements 150, payouts 0)
// I1 ledger: UNKNOWN (read_failed_unavailable)
export function formatLine(r: InvariantResult): string {
  const parts: string[] = [];
  const problems = [pairs(r.violations), r.unknown.join(", ")].filter((s) => s.length > 0);
  if (problems.length > 0) parts.push(problems.join(", "));
  const seen = pairs(r.counts);
  if (seen.length > 0) parts.push(seen);
  return `${r.id} ${r.name}: ${r.verdict}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

// Zero only when all five ran and passed.
export function exitCodeOf(results: InvariantResult[]): 0 | 1 {
  const ids = new Set(results.map((r) => r.id));
  const all = (["I1", "I2", "I3", "I4", "I5"] as const).every((id) => ids.has(id));
  return all && results.length === 5 && results.every((r) => r.verdict === "PASS") ? 0 : 1;
}
