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
