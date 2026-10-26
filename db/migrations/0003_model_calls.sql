-- One log for every model call, whatever the model, plus a separate stop for the auditor model
-- (Muse Wonder) in the global counter. 0002 is applied on Aurora and is never edited.

-- The rename keeps the table's rows, its tenant_isolation policy, FORCE ROW LEVEL SECURITY and
-- the app's grants (all are attached to the table, not its name), so nothing is re-created.
ALTER TABLE ai_calls RENAME TO model_calls;
ALTER INDEX ai_calls_tenant_created_idx RENAME TO model_calls_tenant_created_idx;
-- The primary key and CHECK constraints (and the foreign key) keep their ai_calls_ names on
-- purpose: renaming them is cosmetic, and nothing in the app reads a constraint by its name.

-- target: which model slot made the call. kind: what sort of call it was. units: what a
-- non-token call is billed by (audio seconds, images returned, images segmented). trace_id
-- groups the calls behind one answer.
ALTER TABLE model_calls
  ADD COLUMN target           text CHECK (target IN ('spark', 'wonder', 'spark_open', 'voice', 'image', 'sam')),
  ADD COLUMN kind             text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'transcribe', 'image', 'segment')),
  ADD COLUMN reasoning_effort text CHECK (reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  ADD COLUMN units            integer CHECK (units >= 0),
  ADD COLUMN trace_id         uuid;

-- Backfill, run as the migrating admin. On Aurora that login is not held to row-level security,
-- so these touch every tenant's rows on purpose: each sets only the new column, from the same
-- row's provider, and reads or moves nothing between tenants. Before 0003 only Muse Spark ran
-- on Meta and only Muse Spark Open on Baseten. A row either statement misses fails the NOT NULL
-- below, and the whole file rolls back.
UPDATE model_calls SET target = 'spark' WHERE target IS NULL AND provider = 'meta';
UPDATE model_calls SET target = 'spark_open' WHERE target IS NULL AND provider = 'baseten';
ALTER TABLE model_calls ALTER COLUMN target SET NOT NULL;

-- The calls behind one answer, and per-model totals over time.
CREATE INDEX model_calls_tenant_trace_idx ON model_calls (tenant_id, trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX model_calls_tenant_model_created_idx ON model_calls (tenant_id, model, created_at DESC);

-- The app may change only what a settle writes. Identity, tenant, model, purpose, trace and the
-- reserved amount are fixed once the row is inserted. Revoking the table-wide UPDATE that 0002
-- granted also drops any column grants, so the list below is the whole of it.
REVOKE UPDATE ON model_calls FROM payday_app;
GRANT UPDATE (status, failure, cost_nanocents, input_tokens, cached_tokens, output_tokens,
              reasoning_tokens, upstream_id, http_status, duration_ms, units, settled_at)
  ON model_calls TO payday_app;

-- The auditor's own hard stop, inside the overall one: its spend and reservations, counted on
-- the same row so one row lock covers both caps.
ALTER TABLE ops.ai_spend
  ADD COLUMN wonder_spent_nanocents    bigint NOT NULL DEFAULT 0 CHECK (wonder_spent_nanocents >= 0),
  ADD COLUMN wonder_reserved_nanocents bigint NOT NULL DEFAULT 0 CHECK (wonder_reserved_nanocents >= 0);

-- The app moves the counters and nothing else: the row's id stays 1.
REVOKE UPDATE ON ops.ai_spend FROM payday_app;
GRANT UPDATE (spent_nanocents, reserved_nanocents, wonder_spent_nanocents,
              wonder_reserved_nanocents, calls, updated_at)
  ON ops.ai_spend TO payday_app;
