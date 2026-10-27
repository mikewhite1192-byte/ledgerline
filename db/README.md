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

A reference from one tenant table to another is a composite foreign key on `(tenant_id, x_id)`
against the parent's `UNIQUE (tenant_id, id)`, so a row can never point at another tenant's row
(the insert fails with 23503).

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

## The money ledger (`money_actions`, 0006)

One row per outside money write, reserved before the call. Two things differ from the "Every
tenant table" pattern above, on purpose:

- The app role gets `SELECT, INSERT, UPDATE` and no `DELETE`: the app never removes a ledger
  row. Test fixtures clear their rows with the admin login. A demo reseed (`npm run seed`)
  clears the reseeded tenant's settled rows (`confirmed` or `failed`) through the admin login
  (`WHERE tenant_id = $1`, since that login ignores row-level security) in two halves: settled
  payment rows before the replace, settled accounting rows after it commits. A payout's subject
  refuses a second payout by its own status if the replace fails; a booking has no such status,
  so its ledger row stays until the replace has landed. While
  any row of that tenant is still `reserved`, `sent` or `unknown` (its outside outcome not yet
  known), or has `failure_category = 'amount_mismatch'` in any state (the outside system reported
  a payout for another amount, so `reserve()` keeps that subject closed until a person reviews
  it), the reseed refuses with the counts and their categories only and deletes nothing. The
  delete itself also skips `amount_mismatch` rows, so one that appears after the count stays.
  Nothing else deletes ledger rows, except a tenant's own delete (cascade).
- The `money_actions_guard` trigger (a plain invoker-rights function) enforces the state machine
  on every insert and update, whoever runs it: a new row is a bare `reserved` row; what was
  approved (kind, subject, amount, counterparty, keys, proposal, approver) never changes;
  `reserved` moves to `sent`, or to `failed` as `refused`; `sent` moves to `confirmed`, `failed`
  or `unknown`; `unknown` settles only through a read-back; `confirmed` and `failed` are final;
  `sent_at` is fixed once set and `check_count` never goes down. A refused change raises SQLSTATE
  23514.

Dedupe keys: `UNIQUE (tenant_id, idempotency_key)` with the key `kind:subject_id:attempt`, and
at most one row that is not `failed` per `(tenant_id, kind, subject_id)`.

## QuickBooks (`qbo_connections`, `qbo_oauth_states`, `qbo_entity_ids`, 0007)

Each carrier's link to the one allowed QuickBooks Online sandbox company. All three follow the
"Every tenant table" pattern (forced row-level security, the one `tenant_isolation` policy), with
these differences:

- `qbo_connections` has one row per tenant (`tenant_id` is the key). The two token columns hold
  AES-256-GCM ciphertext sealed by the app with a key that never reaches the database
  (`QBO_TOKEN_KEY`, from Secrets Manager in production), bound to the tenant, the company id and
  the column, so a copied value opens nowhere else. The app refreshes tokens with the row held
  `FOR UPDATE` and stores both new tokens. `connected_by_membership_id` is a composite foreign
  key to `memberships (tenant_id, id)` with no cascade. The app gets `SELECT, INSERT, UPDATE,
  DELETE` (a disconnect deletes the row).
- `qbo_oauth_states` holds a connect in progress: the random state, its membership (composite
  foreign key, cascading), matched whole on the callback, deleted on first use and refused after
  ten minutes (database clock). The app gets `SELECT, INSERT, DELETE`: a state is never changed.
- `qbo_entity_ids` records the company's id for each customer or driver already created there,
  so a second post finds it instead of making another. No foreign key to the local row (a reseed
  replaces those rows and the outside record stays). The app gets `SELECT, INSERT` only: an
  outside id never changes and goes only with the tenant.

## The agent's records (`conversations`, `turns`, `turn_steps`, `proposals`, 0009)

A conversation holds turns, a turn holds its steps, and a proposal is what the agent wants done,
waiting for a person. Each table has the one tenant policy (ENABLE and FORCE) and composite
`(tenant_id, x)` foreign keys. They differ from the "Every tenant table" pattern on purpose:

- The app role gets `SELECT, INSERT` and column-level `UPDATE` only (a turn's outcome, a step's
  state, a proposal's decision, flag and ledger link), and no `DELETE`. What a person asked and
  what was proposed (kind, subject, amount, args) never changes. They are not in `TENANT_TABLES`,
  since the app role cannot delete them; the RLS coverage test lists them by name.
- The `proposals_guard` trigger (invoker rights) moves a proposal only forward: `proposed` to
  `approved`, `rejected` or `expired`; `approved` to `executing` or `failed`; `executing` to `done`
  or `failed`. A flag (`flagged_input_id`), once set, never changes, and the ledger link
  (`money_action_id`) never changes once set. A refused change raises SQLSTATE 23514.
- `money_actions.proposal_id` references the proposal with no delete action, so a proposal the
  ledger names cannot be removed while that row exists, and `proposals.flagged_input_id`
  references the untrusted input the same way.
- Dedupe: `UNIQUE (tenant_id, dedupe_key)` with the key `kind:subject_id:sha256(args)`, and at
  most one `proposed`, `approved` or `executing` proposal per `(tenant_id, kind, subject_id)`.

A demo reseed clears in this order, each clear through the admin login: the settled payout rows,
then the agent's rows (steps, proposals, turns, conversations), then the replace, then the
settled booking rows, then the agent's rows once more. The agent clear keeps every proposal a
ledger row still names, with its turn, that turn's steps and its conversation: before the replace
those are the proposals behind booking rows, which stay until the replace lands, and the second
agent clear removes them once the booking rows are gone. A kept proposal that carries a flag
would block the replace (which deletes the untrusted inputs), so the agent clear refuses while
one exists, with the count only, and deletes nothing; a person reviews it first. Run before the
agent clear, the replace is refused by a proposal's flag and changes nothing.

## The advance flow (`advances` columns, 0011)

No new table. An advance born from a person's approval of an advance proposal carries
`proposal_id`, `source_input_id` (the outside message the ask came in, when there was one),
`decided_at` and `decided_by_membership_id`. Seeded advances leave them null.

- Each is a composite `(tenant_id, x)` foreign key, so a flow row never names another carrier's
  proposal, input or member (23503); the RLS coverage test checks every reference between two
  tenant tables carries `tenant_id` on both sides. The proposal and member references take no
  delete action: removing a proposal or a member a flow row names fails, while a tenant's own
  delete (which cascades to both ends) still works. Deleting the input only clears
  `source_input_id`.
- `UNIQUE (tenant_id, proposal_id)` where set: one advance per proposal, so a second approval
  finds the row and carries on from its state.
- `source` gains `voice`; a flow row is never `seed`; a decision names both its time and its
  member, or neither (23514).
- The grants stay as 0005 set them, `DELETE` included, because a demo reseed replaces advances
  as the app role. The reseed's agent clear deletes flow advances (`proposal_id IS NOT NULL`)
  through the admin login before it deletes proposals.

## Voice notes (`voice_notes`, `voice_note_audio`, 0012)

A driver's voice note, as staff upload it: where it is in the pipeline, the ids of the model calls
that worked on it, and the recording for playback. The transcript is an untrusted input
(`untrusted_inputs`, kind `transcript`, source `voice`), screened like any outside message before a
model reads it; this table holds the English text only after that screen passed.

- The one tenant policy (ENABLE and FORCE) on both tables, `tenant_id` with `ON DELETE CASCADE`,
  and composite `(tenant_id, x)` foreign keys to `drivers`, `untrusted_inputs` and
  `conversations`, each `ON DELETE SET NULL` on its own column.
- The app role gets `SELECT, INSERT` on `voice_notes` and `UPDATE` on the pipeline columns only
  (status, category, language, English text, triage, amount, conversation, reply, the model call
  ids, `updated_at`). Its driver, input, trace and tenant never change. No `DELETE`: nothing in the
  app removes a note.
- The recording is its own row in `voice_note_audio` (one per note, `bytea`, at most 700,000
  bytes, so it reads back under the Data API's 1 MiB answer limit; the size column equals the
  stored length), written by its own statement after the note and its transcript are stored. A
  recording the database refuses leaves the note with none, and the transcription is never paid
  for twice. The app role gets `SELECT, INSERT` only: a recording never changes, and it goes with
  its note (`ON DELETE CASCADE`). The WAV sent to the model is not kept.
- `status` moves `transcribed` to `ready` (or `blocked`, `failed`), then `handed_off`, then
  `replied`; every move is `UPDATE ... WHERE status = <expected>`, so a repeated request changes
  nothing. A `failed` or `blocked` note carries a category, never upstream text.
- One note per input (`UNIQUE (tenant_id, input_id)` where set). Not in `TENANT_TABLES`: the reseed's
  agent clear deletes voice notes (and with them their recordings) through the admin login first,
  before the conversations and the inputs they name.

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
