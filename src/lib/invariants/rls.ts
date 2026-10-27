import { randomUUID } from "node:crypto";
import { DbError, type Db } from "../db/types";
import {
  InvariantReadError,
  flag,
  readAll,
  readAs,
  readFailureCategory,
  resultOf,
  safeName,
  tally,
  whole,
  type InvariantResult,
  type ReadQuery,
} from "./types";

// I5: one carrier never sees another's rows.
// - The catalog, as the admin: every table in public has forced row-level security, exactly one
//   tenant_isolation policy on its tenant column, a uuid NOT NULL tenant column, and an owner
//   other than the app; nothing outside public but the listed global rows; no view or definer
//   function that would read as its owner; the app role is plain.
// - Live, as the app: with carrier A set, every table shows no row of any other tenant and no
//   row of carrier B; the same the other way round; with no tenant set, every table shows no
//   rows; and an insert with no tenant set is refused (42501). That one insert is the only
//   statement here that is not a SELECT: it runs in a transaction that is always rolled back.
// A probe where the other carrier has no rows anywhere proves nothing, so it is UNKNOWN.

export const PROBE_TENANT_SLUGS = ["blue-ridge", "prairie-wind"] as const;

// The only tables outside public: global rows that hold no tenant's data.
export const GLOBAL_TABLES = ["ops.ai_spend"];
// Security-definer functions a migration added on purpose, each with its reason in the migration.
// public.demo_reset_clear (0025): the demo reset's one delete path; it checks the demo carrier and
// the refusals itself under the tenant row lock, and only the app login may call it.
export const ALLOWED_DEFINERS: string[] = ["public.demo_reset_clear"];

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

export const TENANT_PAIR_SQL = `SELECT CAST(id AS text) AS id, slug FROM tenants WHERE slug = $1 OR slug = $2`;

// scope_column: the column the policy scopes by (id on tenants, tenant_id everywhere else).
export const TABLES_SQL = `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
       pg_get_userbyid(c.relowner) = 'payday_app' AS app_owns,
       CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END AS scope_column,
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND NOT a.attisdropped
                  AND a.attname = CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END
                  AND a.atttypid = 'uuid'::regtype AND a.attnotnull) AS scope_column_ok,
       COALESCE((SELECT has_column_privilege('payday_app', c.oid, a.attnum, 'SELECT') FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND NOT a.attisdropped
                    AND a.attname = CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END), false)
         AS app_reads_scope,
       has_any_column_privilege('payday_app', c.oid, 'SELECT') AS app_reads_any
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
 ORDER BY 1`;

export const POLICIES_SQL = `SELECT tablename AS table_name, policyname AS name, permissive, roles::text AS roles, cmd,
       qual, with_check
  FROM pg_policies WHERE schemaname = 'public'`;

export const GLOBALS_SQL = `SELECT n.nspname || '.' || c.relname AS name,
       pg_get_userbyid(c.relowner) = 'payday_app' AS app_owns,
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant_column,
       has_table_privilege('payday_app', c.oid, 'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS app_can
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname <> 'public' AND ${SYSTEM_SCHEMAS} AND c.relkind IN ('r', 'p', 'f')
 ORDER BY 1`;

export const OWNER_READS_SQL = `SELECT
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${SYSTEM_SCHEMAS} AND c.relkind IN ('v', 'm')) AS views,
       COALESCE((SELECT string_agg(n.nspname || '.' || p.proname, ',' ORDER BY 1)
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE ${SYSTEM_SCHEMAS} AND p.prosecdef), '') AS definers,
       COALESCE((SELECT has_schema_privilege('payday_app', n.oid, 'CREATE')
                   FROM pg_namespace n WHERE n.nspname = 'ops'), false) AS app_creates_in_ops`;

export const APP_ROLE_SQL = `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin,
       (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
       has_table_privilege(r.oid, 'public.schema_migrations',
         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS migrations,
       has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
  FROM pg_roles r WHERE r.rolname = 'payday_app'`;

// A reference between two tenant tables carries tenant_id on both sides, so a row can never
// point at another carrier's row.
export const LOOSE_REFERENCES_SQL = `SELECT count(*) AS loose
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  JOIN pg_attribute src ON src.attrelid = c.conrelid AND src.attname = 'tenant_id'
  JOIN pg_attribute dst ON dst.attrelid = c.confrelid AND dst.attname = 'tenant_id'
 WHERE n.nspname = 'public' AND c.contype = 'f'
   AND c.confrelid <> 'public.tenants'::regclass
   AND NOT EXISTS (SELECT 1 FROM generate_subscripts(c.conkey, 1) AS i
                    WHERE c.conkey[i] = src.attnum AND c.confkey[i] = dst.attnum)`;

// The one statement that is not a SELECT. Refused by row security when no tenant is set; if it
// ever were not, the transaction it runs in is rolled back regardless.
export const INSERT_PROBE_SQL = `INSERT INTO tenants (id, slug, name, timezone)
VALUES (CAST($1 AS uuid), 'rls-probe', 'Row security probe', 'UTC')`;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new InvariantReadError("odd_table_name");
  return `"${name}"`;
}

// As the app with a tenant set: rows of any tenant but $1, and rows of $2, in one table.
export function crossReadSql(table: string, column: string): string {
  const col = ident(column);
  return `SELECT count(*) FILTER (WHERE ${col} IS DISTINCT FROM CAST($1 AS uuid)) AS foreign_rows,
       count(*) FILTER (WHERE ${col} = CAST($2 AS uuid)) AS other_rows, count(*) AS seen
  FROM public.${ident(table)}`;
}

export function noTenantReadSql(table: string): string {
  return `SELECT count(*) AS seen FROM public.${ident(table)}`;
}

// As the admin: how many rows each carrier really has in one table.
export function rowsPerTenantSql(table: string, column: string): string {
  const col = ident(column);
  return `SELECT count(*) FILTER (WHERE ${col} = CAST($1 AS uuid)) AS a_rows,
       count(*) FILTER (WHERE ${col} = CAST($2 AS uuid)) AS b_rows
  FROM public.${ident(table)}`;
}

export type TableRow = {
  name: unknown;
  rls: unknown;
  force: unknown;
  app_owns: unknown;
  scope_column: unknown;
  scope_column_ok: unknown;
  app_reads_scope: unknown;
  app_reads_any: unknown;
};
export type PolicyRow = {
  table_name: unknown;
  name: unknown;
  permissive: unknown;
  roles: unknown;
  cmd: unknown;
  qual: unknown;
  with_check: unknown;
};
export type GlobalRow = { name: unknown; app_owns: unknown; tenant_column: unknown; app_can: unknown };
export type OwnerReadsRow = { views: unknown; definers: unknown; app_creates_in_ops: unknown };
export type RoleRow = Record<string, unknown>;
export type CrossRead = { foreign_rows: unknown; other_rows: unknown; seen: unknown };
export type TenantRows = { a_rows: unknown; b_rows: unknown };

// Per table, or the category of why that side of the probe could not be read.
export type Side<T> = { rows: Record<string, T> } | { failed: string };

export type RlsRows = {
  catalog: {
    tables: TableRow[];
    policies: PolicyRow[];
    globals: GlobalRow[];
    ownerReads: OwnerReadsRow[];
    role: RoleRow[];
    looseReferences: { loose: unknown }[];
  };
  // null when the two carriers were not both found.
  live: {
    admin: Side<TenantRows>;
    asA: Side<CrossRead>;
    asB: Side<CrossRead>;
    asNone: Side<{ seen: unknown }>;
  } | null;
  insert: "refused" | "accepted" | "unclear";
};

const EXPECTED_ROLE: Record<string, unknown> = {
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolinherit: false,
  rolcanlogin: true,
  member_of: 0,
  migrations: false,
  can_create: false,
};

function policyScope(table: string): string {
  return table === "tenants" ? "(id = current_tenant_id())" : "(tenant_id = current_tenant_id())";
}

function policyOk(table: string, policies: PolicyRow[]): boolean {
  if (policies.length !== 1) return false;
  const [p] = policies;
  const scope = policyScope(table);
  return (
    p.name === "tenant_isolation" &&
    p.permissive === "PERMISSIVE" &&
    p.roles === "{public}" &&
    p.cmd === "ALL" &&
    p.qual === scope &&
    p.with_check === scope
  );
}

// The tables the live probe reads: in public, with a sound scope column the app may read.
export function probedTables(tables: TableRow[]): { name: string; column: string }[] {
  return tables
    .filter((t) => flag(t.scope_column_ok) && flag(t.app_reads_scope))
    .map((t) => ({ name: String(t.name), column: String(t.scope_column) }));
}

export function judgeRls(rows: RlsRows): InvariantResult {
  const v: Record<string, number> = {};
  const unknown: string[] = [];
  const { catalog, live } = rows;

  const policiesBy = new Map<string, PolicyRow[]>();
  for (const p of catalog.policies) {
    const key = String(p.table_name);
    policiesBy.set(key, [...(policiesBy.get(key) ?? []), p]);
  }

  let noSelect = 0;
  for (const t of catalog.tables) {
    const name = String(t.name);
    const label = safeName(name);
    if (!flag(t.rls)) tally(v, `rls_off:${label}`);
    if (!flag(t.force)) tally(v, `rls_not_forced:${label}`);
    if (flag(t.app_owns)) tally(v, `app_owns:${label}`);
    if (!flag(t.scope_column_ok)) tally(v, `tenant_column_off:${label}`);
    if (!policyOk(name, policiesBy.get(name) ?? [])) tally(v, `policy_off:${label}`);
    if (flag(t.scope_column_ok) && !flag(t.app_reads_scope)) {
      if (flag(t.app_reads_any)) unknown.push(`unprobed:${label}`);
      else noSelect += 1;
    }
  }

  for (const g of catalog.globals) {
    const name = String(g.name);
    if (!GLOBAL_TABLES.includes(name)) tally(v, `global_table_unexpected:${safeName(name)}`);
    else if (flag(g.app_owns) || flag(g.tenant_column) || flag(g.app_can)) {
      tally(v, `global_table_off:${safeName(name)}`);
    }
  }

  if (catalog.ownerReads.length !== 1) throw new InvariantReadError("catalog_unread");
  const [owner] = catalog.ownerReads;
  tally(v, "view_present", whole(owner.views));
  if (typeof owner.definers !== "string") throw new InvariantReadError("catalog_unread");
  const definers = owner.definers.split(",").filter((d) => d.length > 0 && !ALLOWED_DEFINERS.includes(d));
  tally(v, "definer_function", definers.length);
  if (flag(owner.app_creates_in_ops)) tally(v, "app_creates_in_ops");

  if (catalog.role.length !== 1) tally(v, "app_role_missing");
  else {
    const [role] = catalog.role;
    for (const [attr, want] of Object.entries(EXPECTED_ROLE)) {
      const got = attr === "member_of" ? whole(role[attr]) : flag(role[attr]);
      if (got !== want) tally(v, `app_role_off:${attr}`);
    }
  }

  if (catalog.looseReferences.length !== 1) throw new InvariantReadError("catalog_unread");
  tally(v, "loose_reference", whole(catalog.looseReferences[0].loose));

  const probed = probedTables(catalog.tables);
  let bothTenants = 0;
  if (live === null) unknown.push("tenant_pair_missing");
  else {
    const failed = (side: Side<unknown>, as: string) => {
      if ("failed" in side) unknown.push(`${side.failed}:${as}`);
      return "failed" in side;
    };
    const adminFailed = failed(live.admin, "admin");
    const aFailed = failed(live.asA, "as_a");
    const bFailed = failed(live.asB, "as_b");
    const noneFailed = failed(live.asNone, "no_tenant");
    let aHasRows = false;
    let bHasRows = false;
    for (const { name } of probed) {
      const label = safeName(name);
      const counts = "rows" in live.admin ? live.admin.rows[name] : undefined;
      const aRows = counts ? whole(counts.a_rows) : null;
      const bRows = counts ? whole(counts.b_rows) : null;
      if (!adminFailed && (aRows === null || bRows === null)) unknown.push(`unprobed:${label}`);
      if (aRows !== null && bRows !== null) {
        if (aRows > 0) aHasRows = true;
        if (bRows > 0) bHasRows = true;
        if (aRows > 0 && bRows > 0) bothTenants += 1;
      }
      for (const [side, sideFailed, own] of [
        [live.asA, aFailed, aRows],
        [live.asB, bFailed, bRows],
      ] as const) {
        if (sideFailed || !("rows" in side)) continue;
        const read = side.rows[name];
        if (!read) {
          unknown.push(`unprobed:${label}`);
          continue;
        }
        if (whole(read.foreign_rows) > 0 || whole(read.other_rows) > 0) tally(v, `cross_tenant_rows:${label}`);
        // The app sees all of its own rows: a probe that sees fewer is not looking at the data.
        else if (own !== null && whole(read.seen) !== own) unknown.push(`own_rows_mismatch:${label}`);
      }
      if (!noneFailed && "rows" in live.asNone) {
        const read = live.asNone.rows[name];
        if (!read) unknown.push(`unprobed:${label}`);
        else if (whole(read.seen) > 0) tally(v, `no_tenant_rows:${label}`);
      }
    }
    if (!adminFailed && (!aHasRows || !bHasRows)) unknown.push("other_tenant_empty");
  }

  if (rows.insert === "accepted") tally(v, "insert_not_refused");
  else if (rows.insert === "unclear") unknown.push("insert_probe_unclear");

  return resultOf(
    "I5",
    { tables: catalog.tables.length, probed: probed.length, both_tenants: bothTenants, no_select: noSelect },
    v,
    unknown,
  );
}

// ---- Reads ----

export async function readCatalog(q: ReadQuery): Promise<RlsRows["catalog"]> {
  return {
    tables: await q.query<TableRow>(TABLES_SQL),
    policies: await q.query<PolicyRow>(POLICIES_SQL),
    globals: await q.query<GlobalRow>(GLOBALS_SQL),
    ownerReads: await q.query<OwnerReadsRow>(OWNER_READS_SQL),
    role: await q.query<RoleRow>(APP_ROLE_SQL),
    looseReferences: await q.query<{ loose: unknown }>(LOOSE_REFERENCES_SQL),
  };
}

async function side<T>(
  run: () => Promise<Record<string, T>>,
): Promise<Side<T>> {
  try {
    return { rows: await run() };
  } catch (err) {
    return { failed: readFailureCategory(err) };
  }
}

class RollBack extends Error {}

// accepted: the insert went through (and was rolled back); refused: 42501, as it must be.
export async function insertProbe(app: Db): Promise<RlsRows["insert"]> {
  try {
    await app.withoutTenant(async (q) => {
      await q.execute(INSERT_PROBE_SQL, [randomUUID()]);
      throw new RollBack();
    });
    return "unclear";
  } catch (err) {
    if (err instanceof RollBack) return "accepted";
    if (err instanceof DbError && err.sqlState === "42501") return "refused";
    return "unclear";
  }
}

export async function readRls(admin: Db, app: Db): Promise<RlsRows> {
  const catalog = await readAll(admin, readCatalog);
  const probed = probedTables(catalog.tables);
  const pair = await readAll(admin, (q) =>
    q.query<{ id: unknown; slug: unknown }>(TENANT_PAIR_SQL, [...PROBE_TENANT_SLUGS]),
  );
  const idOf = (slug: string) => pair.find((p) => p.slug === slug)?.id;
  const [a, b] = PROBE_TENANT_SLUGS.map(idOf);
  let live: RlsRows["live"] = null;
  if (pair.length === 2 && typeof a === "string" && typeof b === "string") {
    const each = async <T>(q: ReadQuery, sqlOf: (t: { name: string; column: string }) => string, params: string[]) => {
      const out: Record<string, T> = {};
      for (const t of probed) {
        const [row] = await q.query<T>(sqlOf(t), params);
        if (row) out[t.name] = row;
      }
      return out;
    };
    live = {
      admin: await side(() =>
        readAll(admin, (q) => each<TenantRows>(q, (t) => rowsPerTenantSql(t.name, t.column), [a, b])),
      ),
      asA: await side(() => readAs(app, a, (q) => each<CrossRead>(q, (t) => crossReadSql(t.name, t.column), [a, b]))),
      asB: await side(() => readAs(app, b, (q) => each<CrossRead>(q, (t) => crossReadSql(t.name, t.column), [b, a]))),
      asNone: await side(() => readAs(app, null, (q) => each<{ seen: unknown }>(q, (t) => noTenantReadSql(t.name), []))),
    };
  }
  return { catalog, live, insert: await insertProbe(app) };
}

export async function checkRls(admin: Db, app: Db): Promise<InvariantResult> {
  try {
    return judgeRls(await readRls(admin, app));
  } catch (err) {
    return resultOf("I5", {}, {}, [readFailureCategory(err)]);
  }
}
