-- ESCROW-RELEASE (0069): a terminated driver's escrow balance goes back to the driver once a person
-- approves it, through the bank payout rail settlement payouts already use (Stripe test mode, one
-- test connected account). The agent reads the final statement and proposes exactly the balance;
-- only the approval's executor reserves the ledger row and sends. Nothing is emailed or texted.
--
-- 1. escrow_releases: one row per approved release, written as 'issuing' before the ledger row is
--    reserved, so a send that dies leaves a marker a later pass can adopt. One per proposal
--    (escrow_releases_one_per_proposal) and one live release per driver
--    (escrow_releases_one_live_per_driver: issuing, released or unknown); a failed row stays as the
--    record and a retry is a new proposal and a new row. amount_cents never exceeds the balance it
--    was opened against. The driver, the proposal and the ledger row are referenced on
--    (tenant_id, id), so no row can name another carrier's record. The app role may add a row and
--    move its status, ledger row and release stamp; it may never delete one (the demo reset's
--    security-definer function and the seed's admin login do, and a row goes with its carrier, its
--    driver or its proposal).
-- 2. The ledger's kind, subject table and channel checks, re-created as the full union of 0060's
--    lists plus escrow_release (payment, subject escrow_releases, counterparty drivers, bank rail),
--    and a new pairing that keeps the kind on its own subject table. outside_system and the
--    counterparty pairing need no change (stripe_test or mock, drivers). Any later migration that
--    re-creates one of these lists carries these lists whole.
-- 3. proposals_kind_check, the full union of 0066's sixteen kinds, in the same order, plus
--    escrow_release. Added NOT VALID, so this file reads no proposal rows and commits at once;
--    0069_escrow_releases_validate.sql, which the runner applies next in its own transaction, checks
--    the rows already there.
-- 4. demo_reset_clear() re-created whole from its latest definition (0066), unchanged except for one
--    more DELETE (escrow_releases, before the settled ledger rows it names), its variable and its
--    returned row. Every delete 0066 has stays. Same owner, same security definer and search path,
--    same refusals (LR001, LR002, LR003), the same two demo carriers, the same tenant row lock, a
--    tenant filter on every statement, the same revoke and grant.

-- 1. The releases.
CREATE TABLE escrow_releases (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id              uuid NOT NULL,
  proposal_id            uuid NOT NULL,
  -- Set in the ledger's reserve transaction; null only before that.
  money_action_id        uuid,
  -- drivers.escrow_balance_cents when the release was opened.
  opening_balance_cents  bigint NOT NULL CHECK (opening_balance_cents >= 0 AND opening_balance_cents < 1000000000),
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  status                 text NOT NULL CHECK (status IN ('issuing', 'released', 'failed', 'unknown')),
  released_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escrow_releases_within_balance CHECK (amount_cents <= opening_balance_cents),
  CONSTRAINT escrow_releases_released_stamp CHECK ((status = 'released') = (released_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, money_action_id) REFERENCES money_actions (tenant_id, id)
);

CREATE UNIQUE INDEX escrow_releases_one_per_proposal ON escrow_releases (tenant_id, proposal_id);
CREATE UNIQUE INDEX escrow_releases_one_live_per_driver ON escrow_releases (tenant_id, driver_id)
  WHERE status IN ('issuing', 'released', 'unknown');

ALTER TABLE escrow_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON escrow_releases
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE, and no UPDATE of the ids or the amounts: what was approved never changes.
GRANT SELECT, INSERT ON escrow_releases TO payday_app;
GRANT UPDATE (money_action_id, status, released_at, updated_at) ON escrow_releases TO payday_app;

-- 2. The ledger checks, full unions.
--      escrow_release  payment, subject escrow_releases, counterparty drivers (bank rail)
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_kind_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_kind_check
  CHECK (kind IN ('advance_payout', 'advance_expense', 'settlement_payout', 'settlement_bill',
                  'settlement_bill_payment', 'invoice', 'customer_payment', 'factoring_advance',
                  'money_code_issue', 'escrow_release'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_subject_table_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_subject_table_check
  CHECK (subject_table IN ('advances', 'settlements', 'invoices', 'customer_payments', 'money_codes',
                           'escrow_releases'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_check2;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_channel_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_channel_pairing
  CHECK ((channel = 'payment') = (kind IN ('advance_payout', 'settlement_payout', 'factoring_advance',
                                           'money_code_issue', 'escrow_release')));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_escrow_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_escrow_subject_pairing
  CHECK ((kind = 'escrow_release') = (subject_table = 'escrow_releases'));

-- 3. The kind check, seventeen kinds, NOT VALID (validated in 0069_escrow_releases_validate.sql).
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code', 'pay_policy_setup',
  'load_create', 'escrow_release')) NOT VALID;

-- 4. The demo reset, with the escrow releases.
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
    (CAST('proposals' AS text), v_proposals),
    (CAST('turns' AS text), v_turns),
    (CAST('conversations' AS text), v_conversations);
END
$$;

REVOKE ALL ON FUNCTION demo_reset_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset_clear() TO payday_app;
