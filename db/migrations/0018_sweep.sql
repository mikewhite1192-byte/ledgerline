-- The pay sweep: one run checks one open week for every driver, drafts a pay correction for each
-- finding it can fix and lists the rest for a person. It only proposes; a person approves each
-- fix (or a listed set of clean ones, approval_batches below) and the engine applies it.
--
-- sweep_runs: one row per run. A run works in slices (one request each); lease_until and
-- lease_token keep a second worker out while one slice runs. One running run per week
-- (sweep_runs_one_running). cap_cents is the model spend the run may count; spent_cents what it
-- has counted so far (reserved before each call, replaced by the real cost after it).
CREATE TABLE sweep_runs (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id        uuid NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('button', 'schedule')),
  started_by       text NOT NULL CHECK (length(started_by) BETWEEN 1 AND 128),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  phase            text NOT NULL DEFAULT 'find' CHECK (phase IN ('find', 'draft', 'audit', 'done')),
  lease_until      timestamptz,
  lease_token      uuid,
  cap_cents        integer NOT NULL CHECK (cap_cents > 0),
  spent_cents      integer NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  counts           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  truncated_reason text CHECK (truncated_reason ~ '^[a-z_]{2,40}$'),
  failure_category text CHECK (failure_category ~ '^[a-z_]{2,40}$'),
  conversation_id  uuid,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE UNIQUE INDEX sweep_runs_one_running ON sweep_runs (tenant_id, period_id) WHERE status = 'running';
CREATE INDEX sweep_runs_tenant_started ON sweep_runs (tenant_id, started_at DESC);
ALTER TABLE sweep_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sweep_runs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON sweep_runs TO payday_app;
GRANT UPDATE (status, phase, lease_until, lease_token, spent_cents, counts, truncated_reason,
              failure_category, conversation_id, finished_at) ON sweep_runs TO payday_app;

-- sweep_items: one row per leg of a finding's fix plan, per week. finding_key
-- (check:category:table:id:leg of the record at fault) is the dedupe key: a second run over the
-- same week inserts nothing new and drafts only items still found. run_id is the run that found
-- it first, seen_run_id the latest run that found it again (what a run's page lists).
--   plan         the fix leg the engine planned (ids, signed cents, verdict, categories, refs)
--   source_refs  the finding's record refs, [{table, id}], first one the record at fault
--   note         the fixed, code-built line for a person (needs_person), never model text
--   explanation  the model's one-paragraph explanation, kept only if every figure checks out
--   draft_attempts  drafts refused so far; a later run tries a refusal for a passing reason
--                (the turn or a limit read unavailable, a screen or tool error, the day's
--                budget) again while this is under the sweep's own bound, never a lasting one
CREATE TABLE sweep_items (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id           uuid NOT NULL,
  seen_run_id      uuid NOT NULL,
  period_id        uuid NOT NULL,
  finding_key      text NOT NULL CHECK (length(finding_key) BETWEEN 1 AND 300),
  check_name       text NOT NULL CHECK (check_name ~ '^[a-z_]{2,40}$'),
  category         text NOT NULL CHECK (category ~ '^[a-z_]{2,40}$'),
  leg              smallint NOT NULL DEFAULT 1 CHECK (leg BETWEEN 1 AND 9),
  kind             text NOT NULL CHECK (kind IN ('fix', 'needs_person')),
  driver_id        uuid,
  record_table     text CHECK (record_table ~ '^[a-z_]{2,40}$'),
  record_id        uuid,
  expected_cents   integer CHECK (expected_cents IS NULL OR (expected_cents <> 0
                     AND expected_cents BETWEEN -1000000 AND 1000000)),
  plan             jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  source_refs      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_refs) = 'array'),
  note             text CHECK (length(note) <= 300),
  status           text NOT NULL CHECK (status IN ('found', 'drafted', 'mismatch', 'refused',
                     'blocked_live', 'fixed_earlier', 'declined_earlier', 'expired_earlier',
                     'audit_pending', 'over_cap', 'needs_person')),
  refusal_category text CHECK (refusal_category ~ '^[a-z_]{2,40}$'),
  proposal_id      uuid,
  explanation      text CHECK (length(explanation) <= 400),
  explain_category text CHECK (explain_category ~ '^[a-z_]{2,40}$'),
  explain_call_id  uuid,
  audit_attempts   smallint NOT NULL DEFAULT 0 CHECK (audit_attempts >= 0),
  draft_attempts   smallint NOT NULL DEFAULT 0 CHECK (draft_attempts >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'fix') = (plan IS NOT NULL)),
  CHECK (kind = 'fix' OR status = 'needs_person'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_id, finding_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES sweep_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, seen_run_id) REFERENCES sweep_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id)
);
CREATE INDEX sweep_items_tenant_seen ON sweep_items (tenant_id, seen_run_id);
ALTER TABLE sweep_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sweep_items
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON sweep_items TO payday_app;
GRANT UPDATE (seen_run_id, status, refusal_category, proposal_id, explanation, explain_category,
              explain_call_id, audit_attempts, draft_attempts, updated_at) ON sweep_items TO payday_app;

-- SHARED BLOCK approval_batches (design-sweep-notes-reports.md 11): identical in the PAY-SWEEP
-- and SETTLEMENTS migrations, and safe to run twice. Production applies them in merge order and a
-- fresh database in number order, so either may run second; the second one changes nothing.
-- One deliberate approval over a listed set (Discord tip 4). id is the client's batch id, the
-- dedupe key. scope says what item_ids are. requested_by is the session sub (proposals.decided_by
-- holds the same kind of value). Status words: a sweep batch is reserved -> done | refused; a
-- settlements batch is confirmed -> draining -> done | partial.
CREATE TABLE IF NOT EXISTS approval_batches (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('proposals', 'settlements')),
  period_id     uuid,
  item_ids      uuid[] NOT NULL CHECK (cardinality(item_ids) BETWEEN 1 AND 500),
  total_cents   bigint NOT NULL CHECK (total_cents >= 0 AND total_cents < 1000000000),
  legs_reserved integer NOT NULL DEFAULT 0 CHECK (legs_reserved >= 0),
  status        text NOT NULL CHECK (status IN ('reserved', 'refused', 'confirmed', 'draining',
                                                'done', 'partial')),
  result        jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  requested_by  text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 128),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS approval_batches_tenant_created ON approval_batches (tenant_id, created_at DESC);
ALTER TABLE approval_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval_batches;
CREATE POLICY tenant_isolation ON approval_batches
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON approval_batches TO payday_app;
GRANT UPDATE (status, result, legs_reserved, finished_at) ON approval_batches TO payday_app;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_batch_fk;
ALTER TABLE proposals ADD CONSTRAINT proposals_batch_fk
  FOREIGN KEY (tenant_id, batch_id) REFERENCES approval_batches (tenant_id, id);
GRANT UPDATE (batch_id) ON proposals TO payday_app;
-- END SHARED BLOCK

-- An approved pay correction becomes a pay item that names its proposal
-- (item_ref 'correction:<proposal id>'). 0005 declared the check inline, so Postgres named it
-- pay_items_ref_table_check; a NULL ref_table still passes, as before.
ALTER TABLE pay_items DROP CONSTRAINT pay_items_ref_table_check;
ALTER TABLE pay_items ADD CONSTRAINT pay_items_ref_table_check
  CHECK (ref_table IS NULL OR ref_table IN ('fuel_purchases', 'load_accessorials', 'loads',
                                            'settlements', 'proposals'));

-- The sweep's own login in each carrier, for the nightly run: staff, never admin, and its sub is
-- not a Cognito id, so no person can sign in as it. The approve routes take only a Cognito
-- session, so it can never approve. New tenants get theirs from the demo setup script.
INSERT INTO memberships (tenant_id, cognito_sub, email, role)
SELECT t.id, 'service:sweep:' || CAST(t.id AS text), 'sweep@' || t.slug || '.invalid', 'staff'
  FROM tenants t
ON CONFLICT (cognito_sub) DO NOTHING;
