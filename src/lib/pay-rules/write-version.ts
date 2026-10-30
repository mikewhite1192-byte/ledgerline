import type { Queryable } from "../db";
import { assertIdentifier } from "../data/tables";
import { RULES, type RuleKey, type RuleValue } from "./rules";

// The one way an approval writes a new dated version of a carrier's pay rules: a row copied
// column by column from the version it starts from (every column the table has now, read from
// the catalog, so a column a later migration adds rides along) with the approved rules replaced,
// each replacement guarded on the value the approval was checked against. Used by a pay rule
// change (one rule, src/lib/proposals/executors/pay-rule-change.ts) and by pay rules from a
// policy document (many, src/lib/proposals/executors/pay-policy-setup.ts). Inside the caller's
// tenant transaction, after lockPayRules. Nothing else writes pay_configs outside the seed.

// Columns the copy sets itself; every other column is copied from the base version.
export const OWN_COLUMNS: ReadonlySet<string> = new Set(["id", "tenant_id", "effective_from", "note", "source", "created_at"]);

// The SQL type a replaced value is cast to, by the catalog's data_type. Anything else refuses.
const CASTS: Readonly<Record<string, string>> = {
  bigint: "bigint",
  integer: "integer",
  smallint: "smallint",
  text: "text",
};

// The longest note a version keeps (pay_configs.note has no limit of its own; the screen shows one
// line).
export const VERSION_NOTE_MAX = 400;

export async function one(q: Queryable, sql: string, params: (string | number | null)[]): Promise<void> {
  const n = await q.execute(sql, params);
  if (n !== 1) throw new Error("a pay rules write did not change exactly one row");
}

// Every version of the tenant's pay rules locked, then the tenant's pay rules serialized, before
// anything is read: two approvals run one after the other.
export async function lockPayRules(q: Queryable): Promise<void> {
  await q.query("SELECT id FROM pay_configs WHERE tenant_id = current_tenant_id() FOR UPDATE");
  await q.query(
    "SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended('pay_rules:' || CAST(current_tenant_id() AS text), 0))) AS l",
  );
}

// pay_configs' columns as the catalog lists them now, each a plain identifier, with its type.
export async function payConfigColumns(q: Queryable): Promise<Map<string, string>> {
  const rows = await q.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pay_configs'
      ORDER BY ordinal_position`,
  );
  const out = new Map<string, string>();
  for (const r of rows) out.set(assertIdentifier(r.column_name), r.data_type);
  for (const own of OWN_COLUMNS) {
    if (!out.has(own)) throw new Error("pay_configs is missing a column the copy sets");
  }
  return out;
}

export function castFor(columns: Map<string, string>, column: string): string {
  const cast = CASTS[columns.get(column) ?? ""];
  if (!cast) throw new Error("a pay rule's column has no known type");
  return cast;
}

// One rule replaced in the copy: its new value, and the value the base must still hold.
export type Replacement = { key: RuleKey; newValue: RuleValue; oldValue: RuleValue };

export type NewVersion = {
  versionId: string;
  baseVersionId: string;
  effectiveFrom: string;
  note: string;
  replacements: readonly Replacement[];
};

// Inserts the new version: a copy of the base with each replacement's column set to its new
// value, written only while the base still holds every old value (exactly one row, or it throws).
export async function insertVersionCopy(
  q: Queryable,
  columns: Map<string, string>,
  v: NewVersion,
): Promise<void> {
  if (v.replacements.length === 0) throw new Error("a new version replaces at least one rule");
  const params: (string | number | null)[] = [v.versionId, v.effectiveFrom, v.note.slice(0, VERSION_NOTE_MAX), v.baseVersionId];
  const copied = [...columns.keys()].filter((c) => !OWN_COLUMNS.has(c));
  const set = new Map<string, string>();
  const guards: string[] = [];
  const seen = new Set<string>();
  for (const r of v.replacements) {
    const column = assertIdentifier(RULES[r.key].column);
    if (seen.has(column)) throw new Error("a rule is replaced twice");
    seen.add(column);
    if (!copied.includes(column)) throw new Error("a pay rule's column is not in pay_configs");
    const cast = castFor(columns, column);
    params.push(r.newValue);
    set.set(column, `CAST($${params.length} AS ${cast})`);
    params.push(r.oldValue);
    guards.push(`AND ${column} IS NOT DISTINCT FROM CAST($${params.length} AS ${cast})`);
  }
  const values = copied.map((c) => set.get(c) ?? c);
  await one(
    q,
    `INSERT INTO pay_configs (id, tenant_id, effective_from, note, source, ${copied.join(", ")})
     SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($3 AS text), 'proposal',
            ${values.join(", ")}
       FROM pay_configs
      WHERE tenant_id = current_tenant_id() AND id = CAST($4 AS uuid)
        ${guards.join("\n        ")}`,
    params,
  );
}
