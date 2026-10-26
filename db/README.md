# Database migrations

- Plain SQL in `db/migrations/`, forward-only: a merged migration is never edited; a fix is a new
  migration.
- Named `NNNN_short_name.sql` (for example `0001_tenants.sql`) and applied in filename order by
  `scripts/migrate.ts`, one file per transaction and one statement per call. A file's version is
  recorded in `schema_migrations` in the same transaction, so a half-applied file never counts.
- The app talks to Aurora PostgreSQL Serverless v2 through the Data API. Local and CI tests use a
  plain Postgres 16 database built fresh from these files with the same runner.
- Keep the cluster's `log_statement` at `none` (the default). If statement logging is ever turned
  on, set `log_parameter_max_length = 0` first: `scripts/migrate.ts` passes the app role's
  password as a bind parameter, and Postgres logs bind values with logged statements.
- Never keep the `Queryable` after the `withTenant` or `withoutTenant` callback returns. From then
  on every call on it throws a `DbError` and sends no SQL.

## Every tenant table

Each table that holds a carrier's data carries these, in the migration that creates it:

```sql
tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO payday_app;
```

`current_tenant_id()` reads the transaction-local `app.tenant_id` that every app transaction sets
first. Unset means no rows and no writes. `src/lib/db/rls-coverage.db.test.ts` fails CI for any
table in `public` without forced row-level security and exactly that one policy, for a view or a
security-definer function, and for an app role that owns, inherits or bypasses anything.

App SQL uses `$1, $2` parameters and `CAST($1 AS uuid)` rather than the `::` shorthand. Money is
`bigint` cents, never `numeric`.

## The admin login is not held by row-level security

Only `payday_app` is held by the policies. The admin login that runs `scripts/` is not: on
Aurora it is `payday_admin`, the cluster's master user and a member of `rds_superuser`, and
locally and in CI it is a superuser. A read-only probe on Aurora (2026-10-26) showed
`payday_admin`, with `app.tenant_id` set to one carrier, reading another carrier's tenant row,
with FORCE on and `rolbypassrls` false. The header of `0001_tenants.sql` says FORCE holds even
the owner; that is wrong for this owner, which is the admin. The file is applied and never
edited, so this note is the correction.

So a script statement on a tenant table, run as the admin, names its tenant itself:

- `tenants`: `WHERE id = current_tenant_id()`; an insert takes `current_tenant_id()` as `id`.
- any other tenant table: `WHERE tenant_id = current_tenant_id()`; an insert takes
  `current_tenant_id()` as `tenant_id`.

Migrations run as the admin too, with no tenant set, so a migration that changes rows reaches
every carrier unless its own `WHERE` says which. `scripts/lib/demo-rows.db.test.ts` runs the
demo user statements through a local role with BYPASSRLS, the local stand-in for the Aurora
master.

## Local, from a fresh database

With a local Postgres 16 and its admin login:

```sh
DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm run test:db:fresh
```

That drops and recreates `payday_test`, runs `npm run db:migrate -- --target local` against it,
then `npm run test:db`. It refuses any database not on this machine.

## Aurora

From the laptop, with the project's AWS credentials (the script checks the account first):

```sh
EXPECTED_AWS_ACCOUNT_ID=<account id> \
DB_CLUSTER_ARN=<ClusterArn output> \
DB_ADMIN_SECRET_ARN=<AdminSecretArn output> \
DB_SECRET_ARN=<AppSecretArn output> \
DB_NAME=payday \
npm run db:migrate -- --target aurora
```

It applies what is missing, then sets the `payday_app` password from the app secret (as a bound
parameter, never in SQL text). Check what is applied:

```sh
aws rds-data execute-statement --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$DB_ADMIN_SECRET_ARN" --database payday \
  --sql "SELECT version FROM schema_migrations ORDER BY 1"
```
