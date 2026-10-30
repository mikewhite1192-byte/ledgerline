-- DESK LOOP (0063): one always-on loop per carrier. Each wake finds new work in our own tables,
-- hands each piece to the agent that already does it, and writes every step to an insert-only
-- log. The log is the loop's whole state: a later wake resumes from it.
--
-- Nothing here moves money. The loop runs as the carrier's service login (staff, never admin);
-- every write it causes is one an existing button would make.
--
-- The demo reset keeps both tables on purpose (the events handled and the running-since date
-- survive a reset), so demo_reset_clear() is not re-created. Their only foreign key is to tenants,
-- which the reset keeps; a log line's subject is a plain id column.

-- One row per carrier: who holds the loop now, and how far discovery has read.
CREATE TABLE desk_loops (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- The first armed wake; null until then.
  running_since timestamptz,
  -- The lease: one wake at a time per carrier, freed by time if a wake dies.
  lease_token   uuid,
  lease_until   timestamptz,
  -- {card_transactions, customer_payments}: ISO instants, starting at the loop's start date.
  watermarks    jsonb NOT NULL DEFAULT '{}',
  last_wake_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (jsonb_typeof(watermarks) = 'object')
);

ALTER TABLE desk_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_loops FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_loops
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE: the row goes only with its carrier.
GRANT SELECT, INSERT, UPDATE ON desk_loops TO payday_app;

-- Every step of every wake, one line each, never changed. An event's state is its latest line:
-- seen (found), claimed (a try started), carried (still running, the next wake carries it on),
-- then done, failed or skipped (terminal). detail holds only run ids, integer counts, cents and a
-- category word: never error text, record contents or names.
CREATE TABLE desk_log (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wake_id       uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('wake','seen','claimed','carried','done','failed','skipped','sleep')),
  event_key     text CHECK (length(event_key) BETWEEN 1 AND 120),
  source        text CHECK (source IN ('card_transaction','inbound_message','voice_note','customer_payment',
                                       'audit','sweep','collections','cash_check')),
  subject_table text CHECK (length(subject_table) BETWEEN 1 AND 63),
  subject_id    uuid,
  by            text NOT NULL CHECK (by IN ('schedule','button')),
  detail        jsonb NOT NULL DEFAULT '{}',
  CHECK ((kind IN ('wake','sleep')) = (event_key IS NULL)),
  CHECK ((event_key IS NULL) = (source IS NULL)),
  CHECK ((subject_table IS NULL) = (subject_id IS NULL)),
  CHECK (jsonb_typeof(detail) = 'object')
);

-- The dedupe key: one event is done at most once per carrier, whatever the lease does.
CREATE UNIQUE INDEX desk_log_done_once ON desk_log (tenant_id, event_key) WHERE kind = 'done';
CREATE INDEX desk_log_tenant_at ON desk_log (tenant_id, at DESC);
CREATE INDEX desk_log_tenant_key ON desk_log (tenant_id, event_key, at DESC) WHERE event_key IS NOT NULL;

ALTER TABLE desk_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desk_log
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- Insert-only for the app.
GRANT SELECT, INSERT ON desk_log TO payday_app;

-- The backstop behind the missing grants, as money_actions_guard is for the ledger: no line is
-- ever changed, and none is removed except by its carrier's own removal (the foreign key's cascade
-- runs inside the cascade trigger, so its depth is above one). Invoker rights, owned by the
-- migrating admin. The raise rolls the transaction back.
CREATE FUNCTION desk_log_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'desk_log: lines are never changed or removed'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER desk_log_guard
  BEFORE UPDATE OR DELETE ON desk_log
  FOR EACH ROW EXECUTE FUNCTION desk_log_guard();

CREATE TRIGGER desk_log_no_truncate
  BEFORE TRUNCATE ON desk_log
  FOR EACH STATEMENT EXECUTE FUNCTION desk_log_guard();
