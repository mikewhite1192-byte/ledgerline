-- The demo reset (0025) clears the agent's records for a demo carrier and rewrites the seeded
-- tables. An Inbox message (0037) is a record of what a driver sent and what the agent was handed:
-- the demo starts with an empty Inbox, so the reset clears these rows too (DEMO_RESET_CLEARED in
-- src/lib/seed/reset.ts), and payday_app has no DELETE on them.
--
-- demo_reset_clear() re-created whole from its latest definition (0036: 0025, plus the sweep's
-- second checks from 0033, the fuel checks from 0034 and the pay rule changes from 0036), unchanged
-- except for one more DELETE (after the portal's loads, before the voice note recordings and so
-- before the conversations it names), its variable and its returned row. Every delete 0036 has
-- stays. Same owner, same security definer and search path, same refusals (LR001, LR002, LR003),
-- the same two demo carriers, the same tenant row lock, a tenant filter on every statement, the
-- same revoke and grant. A later number than every migration on main that re-creates it, and it
-- applies after 0036 in production too, so on both this one runs last; any later migration that
-- re-creates it starts from the newest definition and keeps every DELETE in it, because whichever
-- re-creation runs last on a database is the function that database keeps
-- (src/lib/seed/reset-coverage.db.test.ts fails otherwise).
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
  v_ledger        bigint;
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

  DELETE FROM public.money_actions m
   WHERE m.tenant_id = v_tenant AND m.state IN ('confirmed', 'failed')
     AND m.failure_category IS DISTINCT FROM 'amount_mismatch';
  GET DIAGNOSTICS v_ledger = ROW_COUNT;

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
    (CAST('money_actions' AS text), v_ledger),
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
    (CAST('proposals' AS text), v_proposals),
    (CAST('turns' AS text), v_turns),
    (CAST('conversations' AS text), v_conversations);
END
$$;

REVOKE ALL ON FUNCTION demo_reset_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset_clear() TO payday_app;
