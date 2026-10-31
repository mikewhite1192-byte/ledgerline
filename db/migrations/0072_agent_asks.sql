-- AGENT ASKS (0072): the agent's own questions about a proposal ("All paperwork is in for load
-- BR-1042. Should I send Dana Reyes the 70% advance, $1,400.00?") and its "told" lines after the
-- autopilot did something inside the owner's limits. The words are written by code
-- (src/lib/asks/words.ts) from the proposal's own numbers and record names; the model writes at
-- most one reason line beside them, and that line is dropped when it names any dollar figure that
-- is not the engine's. Yes goes through the usual approve route and gate; an ask never approves
-- anything by itself.
--
-- 1. agent_asks: one row per question or told line, always about one proposal of the carrier.
--    kind ask | told; status open, snoozed (until snoozed_until), answered (a person approved it
--    from the ask: answered_by, answered_at), done (a told line a person has seen) or void (the
--    proposal expired or was decided somewhere else). A told line is only ever open, done or void,
--    and an ask is never done. One live ask per proposal (agent_asks_one_live_ask) and one told
--    line per proposal (agent_asks_one_told). text is 1 to 400 characters; reason (at most 200)
--    and reason_call_id are set once by the desk's reason pass and never changed.
-- 2. agent_asks_guard: the row moves only forward (open -> snoozed | answered | done | void,
--    snoozed -> snoozed | open | answered | void; answered, done and void are final), the words,
--    the proposal and the subject never change, and the reason is set once.
-- 3. The app role may read, add and change the status columns and the reason, never delete.
-- 4. demo_reset_clear() re-created whole from 0069 with the asks deleted just before the
--    proposals they name (0071 does not re-create it).
--
-- A new, empty table: no existing row is changed or dropped.

-- 1. The asks.
CREATE TABLE agent_asks (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('ask', 'told')),
  proposal_id     uuid NOT NULL,
  subject_table   text NOT NULL CHECK (subject_table ~ '^[a-z_]{2,40}$'),
  subject_id      uuid NOT NULL,
  text            text NOT NULL CHECK (length(text) BETWEEN 1 AND 400),
  reason          text CHECK (length(reason) BETWEEN 1 AND 200),
  reason_call_id  uuid,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'snoozed', 'answered', 'done', 'void')),
  snoozed_until   timestamptz,
  answered_by     text CHECK (length(answered_by) BETWEEN 1 AND 200),
  answered_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id),
  CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL),
  CHECK ((answered_by IS NULL) = (answered_at IS NULL)),
  CHECK ((status = 'answered') = (answered_at IS NOT NULL)),
  CHECK (kind = 'told' OR status <> 'done'),
  CHECK (kind = 'ask' OR status IN ('open', 'done', 'void')),
  CHECK (reason IS NULL OR reason_call_id IS NOT NULL)
);

CREATE UNIQUE INDEX agent_asks_one_live_ask
  ON agent_asks (tenant_id, proposal_id) WHERE kind = 'ask' AND status IN ('open', 'snoozed');
CREATE UNIQUE INDEX agent_asks_one_told
  ON agent_asks (tenant_id, proposal_id) WHERE kind = 'told';
-- The pop-up's poll and the thread: a carrier's live asks, newest first.
CREATE INDEX agent_asks_tenant_status ON agent_asks (tenant_id, status, created_at DESC);

ALTER TABLE agent_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_asks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- 3. No DELETE; the words, the proposal and the subject are never updated.
GRANT SELECT, INSERT ON agent_asks TO payday_app;
GRANT UPDATE (status, snoozed_until, answered_by, answered_at, reason, reason_call_id, updated_at)
  ON agent_asks TO payday_app;

-- 2. Invoker rights, owned by the migrating admin. The raise rolls the transaction back. Every
-- comparison is null-safe, so a null never lets a row through.
CREATE FUNCTION agent_asks_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.answered_at IS NOT NULL OR NEW.snoozed_until IS NOT NULL THEN
      RAISE EXCEPTION 'agent_asks: a new ask starts open' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.subject_table IS DISTINCT FROM OLD.subject_table
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_asks: the words and the proposal never change' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.reason IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason)
     OR (OLD.reason_call_id IS NOT NULL AND NEW.reason_call_id IS DISTINCT FROM OLD.reason_call_id) THEN
    RAISE EXCEPTION 'agent_asks: the reason is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('snoozed', 'answered', 'done', 'void'))
       OR (OLD.status = 'snoozed' AND NEW.status IN ('open', 'answered', 'void'))) THEN
    RAISE EXCEPTION 'agent_asks: an ask moves only forward' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('answered', 'done', 'void')
     AND (NEW.snoozed_until IS DISTINCT FROM OLD.snoozed_until
          OR NEW.answered_by IS DISTINCT FROM OLD.answered_by
          OR NEW.answered_at IS DISTINCT FROM OLD.answered_at) THEN
    RAISE EXCEPTION 'agent_asks: a closed ask does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER agent_asks_guard
  BEFORE INSERT OR UPDATE ON agent_asks
  FOR EACH ROW EXECUTE FUNCTION agent_asks_guard();

-- 4. The demo reset, with the agent's questions.
CREATE OR REPLACE FUNCTION demo_reset_clear()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_tenant        uuid := public.current_tenant_id();
  v_slug          text;
  v_name          text;
  v_timezone      text;
  v_open          bigint;
  v_mismatch      bigint;
  v_flagged       bigint;
  v_escrow_rel    bigint;
  v_ledger        bigint;
  v_ratecon_reads bigint;
  v_documents     bigint;
  v_clips         bigint;
  v_portal_evid   bigint;
  v_portal_checks bigint;
  v_portal_steps  bigint;
  v_portal_sess   bigint;
  v_portal_runs   bigint;
  v_portal_loads  bigint;
  v_inbound       bigint;
  v_audio         bigint;
  v_voice_notes   bigint;
  v_notes         bigint;
  v_steps         bigint;
  v_fanout_checks bigint;
  v_fanout        bigint;
  v_sweep_items   bigint;
  v_sweep_runs    bigint;
  v_fuel_findings bigint;
  v_fuel_runs     bigint;
  v_rule_changes  bigint;
  v_batches       bigint;
  v_advances      bigint;
  v_asks          bigint;
  v_proposals     bigint;
  v_turns         bigint;
  v_conversations bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'demo reset: no tenant is set' USING ERRCODE = 'LR001';
  END IF;

  SELECT t.slug, t.name, t.timezone INTO v_slug, v_name, v_timezone
    FROM public.tenants t WHERE t.id = v_tenant FOR UPDATE;
  -- Whole values, all three from the same carrier. A NULL makes the IN unknown, which refuses too.
  IF NOT FOUND OR ((v_slug, v_name, v_timezone) IN (
       ('blue-ridge', 'Blue Ridge Freight Lines', 'America/New_York'),
       ('prairie-wind', 'Prairie Wind Transport', 'America/Chicago'))) IS NOT TRUE THEN
    RAISE EXCEPTION 'demo reset: not a demo tenant' USING ERRCODE = 'LR002';
  END IF;

  SELECT count(*) FILTER (WHERE m.state IN ('reserved', 'sent', 'unknown')),
         count(*) FILTER (WHERE m.failure_category = 'amount_mismatch')
    INTO v_open, v_mismatch
    FROM public.money_actions m
   WHERE m.tenant_id = v_tenant;
  SELECT count(*) INTO v_flagged
    FROM public.proposals p
   WHERE p.tenant_id = v_tenant AND p.flagged_input_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.money_actions m
                  WHERE m.tenant_id = v_tenant AND m.proposal_id = p.id);
  IF v_open <> 0 OR v_mismatch <> 0 OR v_flagged <> 0 THEN
    RAISE EXCEPTION 'demo reset refused: % open ledger row(s), % amount_mismatch row(s), % flagged proposal(s), nothing was cleared',
      v_open, v_mismatch, v_flagged
      USING ERRCODE = 'LR003';
  END IF;

  -- An escrow release names its settled ledger row (0069); it goes first, so the ledger delete
  -- below finds nothing that still names its rows. An open one was refused above (LR003).
  DELETE FROM public.escrow_releases er WHERE er.tenant_id = v_tenant;
  GET DIAGNOSTICS v_escrow_rel = ROW_COUNT;

  DELETE FROM public.money_actions m
   WHERE m.tenant_id = v_tenant AND m.state IN ('confirmed', 'failed')
     AND m.failure_category IS DISTINCT FROM 'amount_mismatch';
  GET DIAGNOSTICS v_ledger = ROW_COUNT;

  -- A rate confirmation's second reading names its document and its transcript (0066); it goes
  -- before the documents, so their delete cascades into no row, and before the caller rewrites
  -- the inputs it names.
  DELETE FROM public.ratecon_reads rr WHERE rr.tenant_id = v_tenant;
  GET DIAGNOSTICS v_ratecon_reads = ROW_COUNT;

  DELETE FROM public.documents d WHERE d.tenant_id = v_tenant;
  GET DIAGNOSTICS v_documents = ROW_COUNT;

  DELETE FROM public.evidence_clips ec WHERE ec.tenant_id = v_tenant;
  GET DIAGNOSTICS v_clips = ROW_COUNT;

  DELETE FROM public.portal_evidence pe WHERE pe.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_evid = ROW_COUNT;

  DELETE FROM public.portal_run_checks pc WHERE pc.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_checks = ROW_COUNT;

  DELETE FROM public.portal_run_steps ps WHERE ps.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_steps = ROW_COUNT;

  -- A run names its session and the session names its run: both go in this one statement.
  WITH gone_sessions AS (
    DELETE FROM public.portal_sessions px WHERE px.tenant_id = v_tenant RETURNING 1
  ), gone_runs AS (
    DELETE FROM public.portal_runs pr WHERE pr.tenant_id = v_tenant RETURNING 1
  )
  SELECT (SELECT count(*) FROM gone_sessions), (SELECT count(*) FROM gone_runs)
    INTO v_portal_sess, v_portal_runs;

  DELETE FROM public.portal_loads pl WHERE pl.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_loads = ROW_COUNT;

  -- An Inbox message names an untrusted input, a driver, a screening and a conversation, each key
  -- set to null when its row goes, and nothing names it, so no order makes it fail. It goes
  -- before the conversations it names, so their delete updates no row that is about to go, and
  -- before the caller rewrites the inputs and drivers it names.
  DELETE FROM public.inbound_messages im WHERE im.tenant_id = v_tenant;
  GET DIAGNOSTICS v_inbound = ROW_COUNT;

  DELETE FROM public.voice_note_audio r WHERE r.tenant_id = v_tenant;
  GET DIAGNOSTICS v_audio = ROW_COUNT;

  DELETE FROM public.voice_notes v WHERE v.tenant_id = v_tenant;
  GET DIAGNOSTICS v_voice_notes = ROW_COUNT;

  DELETE FROM public.driver_notes n WHERE n.tenant_id = v_tenant;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  DELETE FROM public.turn_steps s WHERE s.tenant_id = v_tenant;
  GET DIAGNOSTICS v_steps = ROW_COUNT;

  -- The sweep's second checks name a run, a driver and a turn; each run's second check names
  -- the run and its turns (0024). Both go before the runs and the turns.
  DELETE FROM public.sweep_fanout_checks fc WHERE fc.tenant_id = v_tenant;
  GET DIAGNOSTICS v_fanout_checks = ROW_COUNT;

  DELETE FROM public.sweep_fanout sf WHERE sf.tenant_id = v_tenant;
  GET DIAGNOSTICS v_fanout = ROW_COUNT;

  -- The pay sweep's findings name a proposal and a run; its runs name a conversation (0018).
  DELETE FROM public.sweep_items si WHERE si.tenant_id = v_tenant;
  GET DIAGNOSTICS v_sweep_items = ROW_COUNT;

  DELETE FROM public.sweep_runs sr WHERE sr.tenant_id = v_tenant;
  GET DIAGNOSTICS v_sweep_runs = ROW_COUNT;

  -- A fuel finding names a fill-up, a driver, a load and a pay line the replace deletes, and the
  -- card it drafted, so it goes before the proposals; its runs go after it (0031).
  DELETE FROM public.fuel_findings ff WHERE ff.tenant_id = v_tenant;
  GET DIAGNOSTICS v_fuel_findings = ROW_COUNT;

  DELETE FROM public.fuel_check_runs fr WHERE fr.tenant_id = v_tenant;
  GET DIAGNOSTICS v_fuel_runs = ROW_COUNT;

  -- A pay rule change names the proposal it came from and the version it wrote (0030); the
  -- replace rewrites the versions, so the changes go with the agent's records.
  DELETE FROM public.pay_rule_changes rc WHERE rc.tenant_id = v_tenant;
  GET DIAGNOSTICS v_rule_changes = ROW_COUNT;

  DELETE FROM public.advances a WHERE a.tenant_id = v_tenant AND a.proposal_id IS NOT NULL;
  GET DIAGNOSTICS v_advances = ROW_COUNT;

  -- An agent question names its proposal (0072), so the questions go just before the proposals.
  DELETE FROM public.agent_asks aa WHERE aa.tenant_id = v_tenant;
  GET DIAGNOSTICS v_asks = ROW_COUNT;

  DELETE FROM public.proposals p WHERE p.tenant_id = v_tenant;
  GET DIAGNOSTICS v_proposals = ROW_COUNT;

  -- A proposal an approve-all batch approved names that batch (proposals.batch_id, 0018), so the
  -- batches go after the proposals. A batch also names a pay week the replace deletes.
  DELETE FROM public.approval_batches ab WHERE ab.tenant_id = v_tenant;
  GET DIAGNOSTICS v_batches = ROW_COUNT;

  DELETE FROM public.turns t WHERE t.tenant_id = v_tenant;
  GET DIAGNOSTICS v_turns = ROW_COUNT;

  DELETE FROM public.conversations c WHERE c.tenant_id = v_tenant;
  GET DIAGNOSTICS v_conversations = ROW_COUNT;

  RETURN QUERY VALUES
    (CAST('escrow_releases' AS text), v_escrow_rel),
    (CAST('money_actions' AS text), v_ledger),
    (CAST('ratecon_reads' AS text), v_ratecon_reads),
    (CAST('documents' AS text), v_documents),
    (CAST('evidence_clips' AS text), v_clips),
    (CAST('portal_evidence' AS text), v_portal_evid),
    (CAST('portal_run_checks' AS text), v_portal_checks),
    (CAST('portal_run_steps' AS text), v_portal_steps),
    (CAST('portal_sessions' AS text), v_portal_sess),
    (CAST('portal_runs' AS text), v_portal_runs),
    (CAST('portal_loads' AS text), v_portal_loads),
    (CAST('inbound_messages' AS text), v_inbound),
    (CAST('voice_note_audio' AS text), v_audio),
    (CAST('voice_notes' AS text), v_voice_notes),
    (CAST('driver_notes' AS text), v_notes),
    (CAST('turn_steps' AS text), v_steps),
    (CAST('sweep_fanout_checks' AS text), v_fanout_checks),
    (CAST('sweep_fanout' AS text), v_fanout),
    (CAST('sweep_items' AS text), v_sweep_items),
    (CAST('sweep_runs' AS text), v_sweep_runs),
    (CAST('fuel_findings' AS text), v_fuel_findings),
    (CAST('fuel_check_runs' AS text), v_fuel_runs),
    (CAST('pay_rule_changes' AS text), v_rule_changes),
    (CAST('approval_batches' AS text), v_batches),
    (CAST('advances' AS text), v_advances),
    (CAST('agent_asks' AS text), v_asks),
    (CAST('proposals' AS text), v_proposals),
    (CAST('turns' AS text), v_turns),
    (CAST('conversations' AS text), v_conversations);
END
$$;

REVOKE ALL ON FUNCTION demo_reset_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset_clear() TO payday_app;
