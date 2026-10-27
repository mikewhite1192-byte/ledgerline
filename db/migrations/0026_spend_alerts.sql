-- Spend watch: a per-job stop inside the overall model budget. Before a model call is reserved,
-- the wrapper sums what the same job spent in the last 60 minutes, or since its last clear when
-- that is more recent (src/lib/ai/watch.ts). A call that would take the job past its hourly
-- allowance is refused, nothing is written to the model ledger, and one alert row is written
-- here. The job then stays stopped until an admin clears the alert on the Meta models page; the
-- clear records who and when.
--
-- A job is one trace (the calls behind one answer) when the call has a trace, and otherwise the
-- carrier's calls for one purpose with no trace.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. The person who cleared an alert is a membership
-- of the same carrier, through a composite foreign key on (tenant_id, cleared_by).
--
-- Grants are narrower than the README's default: SELECT, INSERT and an UPDATE of the two clear
-- columns only, and no DELETE. An alert is the record that a job was stopped and who let it run
-- again. Deleting a tenant removes its alerts through the cascade.
--
-- Rows hold ids, a purpose, two amounts in nanocents and timestamps. No prompt, model output or
-- upstream error is stored.

CREATE TABLE spend_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The job: its trace, or null for a job grouped by purpose alone.
  trace_id        uuid,
  -- The purpose of the call that was refused.
  purpose         text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{2,39}$'),
  -- The hour the sum covered (it starts later when an earlier alert was cleared inside it).
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  -- What the job had spent in the window plus the refused call's reservation, and the
  -- allowance it went past. One cent is 1,000,000,000 nanocents.
  spent_nanocents bigint NOT NULL CHECK (spent_nanocents >= 0),
  limit_nanocents bigint NOT NULL CHECK (limit_nanocents > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cleared_at      timestamptz,
  cleared_by      uuid,
  CHECK (window_start <= window_end),
  CHECK (spent_nanocents > limit_nanocents),
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL)),
  FOREIGN KEY (tenant_id, cleared_by) REFERENCES memberships (tenant_id, id)
);

-- At most one open alert per job: a second refusal of a stopped job writes nothing new. Two
-- indexes, because a unique index treats every null trace as distinct.
CREATE UNIQUE INDEX spend_alerts_open_trace_key ON spend_alerts (tenant_id, trace_id)
  WHERE cleared_at IS NULL AND trace_id IS NOT NULL;
CREATE UNIQUE INDEX spend_alerts_open_purpose_key ON spend_alerts (tenant_id, purpose)
  WHERE cleared_at IS NULL AND trace_id IS NULL;
CREATE INDEX spend_alerts_tenant_created_idx ON spend_alerts (tenant_id, created_at DESC);

ALTER TABLE spend_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spend_alerts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON spend_alerts TO payday_app;
GRANT UPDATE (cleared_at, cleared_by) ON spend_alerts TO payday_app;

-- The hourly sum for a job with no trace reads the carrier's calls for one purpose by time. A job
-- with a trace uses model_calls_tenant_trace_idx from 0003.
CREATE INDEX model_calls_tenant_purpose_created_idx ON model_calls (tenant_id, purpose, created_at);
