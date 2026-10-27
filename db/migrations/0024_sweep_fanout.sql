-- The sweep's second opinion (fan-out): after the engine's findings are written, one ordering
-- call (Muse Wonder) ranks the week's drivers, one short check per driver (Muse Spark) reads that
-- driver's records with five read tools, and one comparison call (Muse Wonder) writes how the
-- checks and the engine's findings line up. It reads and labels only: it creates no proposal and
-- computes no number. An issue only a checker raised becomes a needs_person sweep item.
--
-- sweep_runs gains:
--   reserved_cents  model spend held for calls in flight; a call's reserve moves to spent_cents
--                   at its real cost once known, and the whole reserve while it is unknown, so
--                   spent_cents + reserved_cents never passes cap_cents
--   fanout          the run took the second opinion (the per-carrier daily count reads it)
--   own_spent_cents the part of spent_cents the sweep's own calls (explain, audit) counted, kept
--                   within the sweep's own budget even when the run's cap is raised for the
--                   second opinion
-- and two phases between find and draft: plan, check, reconcile.
ALTER TABLE sweep_runs
  ADD COLUMN reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  ADD COLUMN fanout boolean NOT NULL DEFAULT false,
  ADD COLUMN own_spent_cents integer NOT NULL DEFAULT 0 CHECK (own_spent_cents >= 0);
ALTER TABLE sweep_runs DROP CONSTRAINT sweep_runs_phase_check;
ALTER TABLE sweep_runs ADD CONSTRAINT sweep_runs_phase_check
  CHECK (phase IN ('find', 'plan', 'check', 'reconcile', 'draft', 'audit', 'done'));
GRANT UPDATE (reserved_cents, fanout, own_spent_cents) ON sweep_runs TO payday_app;

-- sweep_fanout: one row per run that reached the plan phase, ever (run_id is the key). The turn
-- ids name the ordering and comparison calls' turns, for the run page's "how it was checked".
--   plan_json       the validated order (driver ids, priority, focus categories, a short brief)
--   reconcile_json  the comparison's summary and disagreements, null when it did not answer
--   counts          the server's own agreement counts, written whatever the comparison did
CREATE TABLE sweep_fanout (
  run_id             uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('planning', 'checking', 'reconciling', 'done',
                       'plan_skipped', 'plan_budget', 'skipped_daily_cap')),
  plan_turn_id       uuid,
  plan_call_id       uuid,
  plan_attempts      integer NOT NULL DEFAULT 0 CHECK (plan_attempts BETWEEN 0 AND 2),
  plan_json          jsonb CHECK (plan_json IS NULL OR jsonb_typeof(plan_json) = 'object'),
  reconcile_turn_id  uuid,
  reconcile_call_id  uuid,
  reconcile_attempts integer NOT NULL DEFAULT 0 CHECK (reconcile_attempts BETWEEN 0 AND 2),
  reconcile_json     jsonb CHECK (reconcile_json IS NULL OR jsonb_typeof(reconcile_json) = 'object'),
  counts             jsonb CHECK (counts IS NULL OR jsonb_typeof(counts) = 'object'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES sweep_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_turn_id) REFERENCES turns (tenant_id, id),
  FOREIGN KEY (tenant_id, reconcile_turn_id) REFERENCES turns (tenant_id, id)
);
ALTER TABLE sweep_fanout ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_fanout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sweep_fanout
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON sweep_fanout TO payday_app;
GRANT UPDATE (status, plan_turn_id, plan_call_id, plan_attempts, plan_json, reconcile_turn_id,
              reconcile_call_id, reconcile_attempts, reconcile_json, counts, finished_at)
  ON sweep_fanout TO payday_app;

-- sweep_fanout_checks: one row per driver per run, inserted once from the validated order. A
-- check is leased (lease_token, lease_until) inside the run's own lease; its answer is written
-- only by the holder of that lease and only once (result IS NULL). attempts counts leases taken,
-- at most two. cost_cents is the check's real spend once read back.
CREATE TABLE sweep_fanout_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL,
  driver_id      uuid NOT NULL,
  priority       smallint NOT NULL CHECK (priority BETWEEN 1 AND 3),
  focus          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(focus) = 'array'),
  brief          text CHECK (brief IS NULL OR length(brief) <= 240),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done',
                   'unparsed', 'timed_out', 'budget', 'error')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  lease_token    uuid,
  lease_until    timestamptz,
  turn_id        uuid,
  result         jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  cost_cents     integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  started_at     timestamptz,
  finished_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, driver_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES sweep_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, turn_id) REFERENCES turns (tenant_id, id)
);
CREATE INDEX sweep_fanout_checks_queue ON sweep_fanout_checks (run_id, status, priority, driver_id);
ALTER TABLE sweep_fanout_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_fanout_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sweep_fanout_checks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON sweep_fanout_checks TO payday_app;
GRANT UPDATE (status, attempts, lease_token, lease_until, turn_id, result, cost_cents, started_at,
              finished_at)
  ON sweep_fanout_checks TO payday_app;
