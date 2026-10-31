-- RECOVERY (0080): money that went out wrong comes back. A fuel card load paid against the wrong
-- advance, or to a driver whose truck broke down before the trip, is pulled back off the card once
-- a person approves it (card_pullback); what the card could not give back on a breakdown is booked
-- as a named deficit; a deficit is recovered from pay a part at a time; a load can be cancelled
-- after its advance went out. This file carries every schema change those three slices need; each
-- is additive, and every CHECK re-created on a table that already has rows is added NOT VALID and
-- checked by 0080_recovery_validate.sql, which the runner applies next in its own transaction.
--
-- 1. card_pullbacks: one row per approved pull, written as 'issuing' before the ledger row is
--    reserved, so a send that dies leaves a marker a later pass can adopt. One per proposal, one
--    live pull per driver (issuing or unknown) and one live or finished pull per advance; a failed
--    row stays as the record and a retry is a new proposal and a new row. The numbers are the rules
--    engine's: a breakdown's pull plus its shortfall is what was asked for, the pull never exceeds
--    the card's balance, and a pull against an advance never leaves a shortfall and may be less than
--    asked for (what the card could not give back stays owed on the advance). Every reference carries tenant_id. The app role may add a row and move
--    its status, ledger row and pulled stamp; it may never delete one.
-- 2. The ledger's kind, subject table and channel checks, re-created as the full union of 0069's
--    lists plus card_pullback (payment, subject card_pullbacks, counterparty drivers, no rail: the
--    simulated card provider's own pull member), and a new pairing that keeps the kind on its own
--    subject table. outside_system and the counterparty pairing need no change (fuel_card_sim,
--    drivers). Re-created NOT VALID.
-- 3. proposals_kind_check, the full union of 0078's nineteen kinds, in the same order, plus
--    card_pullback and deficit_book; proposals_subject_table_check, 0053's list plus
--    driver_deficits. Both NOT VALID. 0070's autopilot_rules kind check is not widened, on purpose:
--    no rule row can name either kind.
-- 4. driver_deficits: recovered_cents for a partial recovery from pay, never above the amount, and
--    whole once the deficit is settled. Both NOT VALID; every stored deficit has recovered_cents 0
--    and settled_in null.
-- 5. settlement_lines kind: 0005's ten plus deficit_recovery. NOT VALID.
-- 6. load_events: a cancel step. to_status gains cancelled and load_events_one_step gains a cancel
--    from planned or in_transit. Both NOT VALID; from_status and source are unchanged.
-- 7. demo_reset_clear() re-created whole from 0078, unchanged except for one more DELETE
--    (card_pullbacks, first: it names proposals, the ledger and the advances), its variable and its
--    returned row. LR003 already refuses a reset while any ledger row is open, which covers an
--    issuing or unknown pull.

-- 1. The pull-backs.
CREATE TABLE card_pullbacks (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id        uuid NOT NULL,
  card_id          uuid NOT NULL,
  proposal_id      uuid NOT NULL,
  -- The advance taken back; null on a breakdown.
  advance_id       uuid,
  reason           text NOT NULL CHECK (reason IN ('driver_request', 'duplicate', 'wrong_driver', 'wrong_load', 'breakdown', 'other')),
  requested_cents  bigint NOT NULL CHECK (requested_cents > 0 AND requested_cents < 1000000000),
  balance_cents    bigint NOT NULL CHECK (balance_cents >= 0 AND balance_cents < 1000000000),
  pull_cents       bigint NOT NULL CHECK (pull_cents > 0 AND pull_cents < 1000000000),
  shortfall_cents  bigint NOT NULL CHECK (shortfall_cents >= 0 AND shortfall_cents < 1000000000),
  -- Set in the ledger's reserve transaction; null only before that.
  money_action_id  uuid,
  status           text NOT NULL CHECK (status IN ('issuing', 'pulled', 'failed', 'unknown')),
  pulled_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A breakdown's pull plus its shortfall is what was asked for. A pull against an advance has no
  -- shortfall and may be less than asked for: the rest stays owed on the advance.
  CONSTRAINT card_pullbacks_sum CHECK (pull_cents + shortfall_cents = requested_cents
                                       OR (advance_id IS NOT NULL AND pull_cents < requested_cents)),
  CONSTRAINT card_pullbacks_within_balance CHECK (pull_cents <= balance_cents),
  CONSTRAINT card_pullbacks_pulled_stamp CHECK ((status = 'pulled') = (pulled_at IS NOT NULL)),
  CONSTRAINT card_pullbacks_advance_whole CHECK (advance_id IS NULL OR shortfall_cents = 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id)       REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, card_id)         REFERENCES driver_cards (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id)     REFERENCES proposals (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, advance_id)      REFERENCES advances (tenant_id, id),
  FOREIGN KEY (tenant_id, money_action_id) REFERENCES money_actions (tenant_id, id)
);
CREATE UNIQUE INDEX card_pullbacks_one_per_proposal ON card_pullbacks (tenant_id, proposal_id);
CREATE UNIQUE INDEX card_pullbacks_one_live_per_driver ON card_pullbacks (tenant_id, driver_id)
  WHERE status IN ('issuing', 'unknown');
CREATE UNIQUE INDEX card_pullbacks_one_per_advance ON card_pullbacks (tenant_id, advance_id)
  WHERE advance_id IS NOT NULL AND status IN ('issuing', 'pulled', 'unknown');
CREATE INDEX card_pullbacks_tenant_card ON card_pullbacks (tenant_id, card_id, status);
ALTER TABLE card_pullbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_pullbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON card_pullbacks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE, and no UPDATE of the ids or the amounts: what was approved never changes.
GRANT SELECT, INSERT ON card_pullbacks TO payday_app;
GRANT UPDATE (money_action_id, status, pulled_at, updated_at) ON card_pullbacks TO payday_app;

-- 2. The ledger checks, full unions, NOT VALID (validated in 0080_recovery_validate.sql).
--      card_pullback  payment, subject card_pullbacks, counterparty drivers (the card provider)
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_kind_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_kind_check
  CHECK (kind IN ('advance_payout', 'advance_expense', 'settlement_payout', 'settlement_bill',
                  'settlement_bill_payment', 'invoice', 'customer_payment', 'factoring_advance',
                  'money_code_issue', 'escrow_release', 'card_pullback')) NOT VALID;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_subject_table_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_subject_table_check
  CHECK (subject_table IN ('advances', 'settlements', 'invoices', 'customer_payments', 'money_codes',
                           'escrow_releases', 'card_pullbacks')) NOT VALID;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_channel_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_channel_pairing
  CHECK ((channel = 'payment') = (kind IN ('advance_payout', 'settlement_payout', 'factoring_advance',
                                           'money_code_issue', 'escrow_release', 'card_pullback'))) NOT VALID;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_pullback_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_pullback_subject_pairing
  CHECK ((kind = 'card_pullback') = (subject_table = 'card_pullbacks')) NOT VALID;

-- 3. The proposals checks: twenty-one kinds and one more citable table, NOT VALID.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code', 'pay_policy_setup',
  'load_create', 'escrow_release', 'load_move', 'card_load_ruling', 'card_pullback',
  'deficit_book')) NOT VALID;
ALTER TABLE proposals DROP CONSTRAINT proposals_subject_table_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_subject_table_check CHECK (subject_table IN (
  'customers', 'drivers', 'loads', 'load_state_miles', 'load_accessorials', 'driver_days',
  'fuel_purchases', 'pay_configs', 'deduction_schedules', 'pay_items', 'advances',
  'settlement_periods', 'settlements', 'settlement_lines', 'invoices', 'customer_payments',
  'payment_applications', 'vendor_bills', 'card_transactions', 'pinned_rates',
  'driver_deficits')) NOT VALID;

-- 4. Partial recovery of a deficit, NOT VALID.
ALTER TABLE driver_deficits
  ADD COLUMN recovered_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE driver_deficits ADD CONSTRAINT driver_deficits_recovered_within
  CHECK (recovered_cents >= 0 AND recovered_cents <= amount_cents) NOT VALID;
ALTER TABLE driver_deficits ADD CONSTRAINT driver_deficits_settled_whole
  CHECK (settled_in IS NULL OR recovered_cents = amount_cents) NOT VALID;
GRANT UPDATE (settled_in, recovered_cents) ON driver_deficits TO payday_app;

-- 5. The pay line kinds: 0005's ten plus deficit_recovery, NOT VALID. 0005's check is inline, so
--    its name is the one Postgres gave it (read from a fresh database: settlement_lines_kind_check).
ALTER TABLE settlement_lines DROP CONSTRAINT settlement_lines_kind_check;
ALTER TABLE settlement_lines ADD CONSTRAINT settlement_lines_kind_check CHECK (kind IN (
  'load_pay', 'accessorial_pay', 'reimbursement', 'fuel', 'other_deduction', 'carried_shortfall',
  'lease', 'insurance', 'escrow', 'advance_recovery', 'deficit_recovery')) NOT VALID;

-- 6. The cancel step, NOT VALID. 0071's to_status check is inline (load_events_to_status_check).
ALTER TABLE load_events DROP CONSTRAINT load_events_to_status_check;
ALTER TABLE load_events ADD CONSTRAINT load_events_to_status_check
  CHECK (to_status IN ('in_transit', 'delivered', 'cancelled')) NOT VALID;
ALTER TABLE load_events DROP CONSTRAINT load_events_one_step;
ALTER TABLE load_events ADD CONSTRAINT load_events_one_step CHECK (
  (from_status = 'planned' AND to_status = 'in_transit')
  OR (from_status = 'in_transit' AND to_status = 'delivered')
  OR (from_status IN ('planned', 'in_transit') AND to_status = 'cancelled')) NOT VALID;

-- 7. The demo reset, with the card pull-backs.
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
  v_pullbacks     bigint;
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
  v_deficits      bigint;
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

  -- A card pull-back names its ledger row, its proposal, its card and the advance it took back
  -- (0080); it goes first, so the ledger delete below finds nothing that still names its rows. An
  -- open one was refused above (LR003).
  DELETE FROM public.card_pullbacks cp WHERE cp.tenant_id = v_tenant;
  GET DIAGNOSTICS v_pullbacks = ROW_COUNT;

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

  -- A driver deficit names its driver, the member who ruled and the proposal it came from (0078),
  -- so the deficits go before the proposals; the replace rewrites the drivers.
  DELETE FROM public.driver_deficits dd WHERE dd.tenant_id = v_tenant;
  GET DIAGNOSTICS v_deficits = ROW_COUNT;

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
    (CAST('card_pullbacks' AS text), v_pullbacks),
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
    (CAST('driver_deficits' AS text), v_deficits),
    (CAST('agent_asks' AS text), v_asks),
    (CAST('proposals' AS text), v_proposals),
    (CAST('turns' AS text), v_turns),
    (CAST('conversations' AS text), v_conversations);
END
$$;

REVOKE ALL ON FUNCTION demo_reset_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset_clear() TO payday_app;
