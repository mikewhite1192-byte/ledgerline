-- SETTLEMENTS: the week's pay is run, checked against its sources, approved one paystub at a time
-- or all clean ones at once, paid out and booked. This file adds the batch reference on the ledger
-- row, the settlement_approve proposal kind, and the parity columns the paid settlement and the
-- driver carry (what a paid settlement did to escrow, the insurance exemption, and the park a
-- draft gets when its lines no longer match their sources).
--
-- Escrow stays at or above zero and pay items keep their four kinds: the rules engine refuses a
-- negative escrow balance and an escrow charge today, so the schema refuses them too. Escrow
-- charges and a balance that can run below zero are a later item that widens the engine and these
-- checks together.
--
-- The approval batch itself (approval_batches, proposals.batch_id) is the SHARED BLOCK that
-- 0018_sweep.sql already created, as is the pay_items_ref_table_check widening; this file runs
-- after 0018 on a fresh database and in production alike, so it only uses them.
--
-- Nothing here moves money. Every write to the outside world still goes through money_actions,
-- whose guard below learns one more column that never changes once written.

-- The batch reference on the ledger row, written at INSERT (the guard allows no other write of a
-- reserved row's identity) and never changed.
ALTER TABLE money_actions ADD COLUMN batch_id uuid;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_batch_fk
  FOREIGN KEY (tenant_id, batch_id) REFERENCES approval_batches (tenant_id, id);
CREATE INDEX money_actions_tenant_batch ON money_actions (tenant_id, batch_id)
  WHERE batch_id IS NOT NULL;

-- Settlement proposals ride the same kind list. Re-created constraints list the full union.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill',
  'invoice_post', 'payment_reapply', 'settlement_approve', 'detention_charge',
  'factoring_request', 'bill_defer', 'collections_chase', 'pay_rule_change'));

-- The guard from 0006, whole, with one more column in "what was approved never changes":
-- batch_id.
CREATE OR REPLACE FUNCTION money_actions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.check_count <> 0 OR NEW.failure_category IS NOT NULL
       OR NEW.settled_via IS NOT NULL OR NEW.outside_system IS NOT NULL
       OR NEW.outside_type IS NOT NULL OR NEW.outside_id IS NOT NULL
       OR NEW.outside_ref IS NOT NULL OR NEW.outside_amount_cents IS NOT NULL
       OR NEW.sent_at IS NOT NULL OR NEW.settled_at IS NOT NULL
       OR NEW.last_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'money_actions: a new row must be a bare reservation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.subject_table IS DISTINCT FROM OLD.subject_table
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.counterparty_table IS DISTINCT FROM OLD.counterparty_table
     OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.approver_membership_id IS DISTINCT FROM OLD.approver_membership_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'money_actions: what was approved never changes'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'money_actions: a settled row is final' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('sent', 'failed'))
       OR (OLD.state = 'sent' AND NEW.state IN ('confirmed', 'failed', 'unknown'))
       OR (OLD.state = 'unknown' AND NEW.state IN ('confirmed', 'failed', 'unknown'))) THEN
    RAISE EXCEPTION 'money_actions: transition not allowed' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'failed'
     AND COALESCE(NEW.settled_via, '') <> 'refused' THEN
    RAISE EXCEPTION 'money_actions: a reservation fails only as refused'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'sent' AND NEW.state IN ('confirmed', 'failed')
     AND COALESCE(NEW.settled_via, '') NOT IN ('response', 'read_back') THEN
    RAISE EXCEPTION 'money_actions: a sent row settles by response or read-back'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'unknown' AND NEW.state IN ('confirmed', 'failed')
     AND COALESCE(NEW.settled_via, '') <> 'read_back' THEN
    RAISE EXCEPTION 'money_actions: an unknown row settles only by read-back'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'money_actions: sent_at never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.check_count < OLD.check_count THEN
    RAISE EXCEPTION 'money_actions: the check count never goes down'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

-- A driver who carries their own insurance pays no daily insurance charge. A flag read at run
-- time, so a change applies to the next run as a whole week.
ALTER TABLE drivers ADD COLUMN own_insurance boolean NOT NULL DEFAULT false;

-- What a paid settlement did to escrow: opening, charges posted (always zero until escrow charges
-- are booked), withheld, closing. A draft keeps zeros until it is booked.
ALTER TABLE settlements
  ADD COLUMN escrow_opening_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_opening_cents >= 0 AND escrow_opening_cents < 1000000000),
  ADD COLUMN escrow_charges_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_charges_cents >= 0 AND escrow_charges_cents < 1000000000),
  ADD COLUMN escrow_withheld_cents bigint NOT NULL DEFAULT 0
             CHECK (escrow_withheld_cents >= 0 AND escrow_withheld_cents < 1000000000),
  ADD COLUMN escrow_closing_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_closing_cents >= 0 AND escrow_closing_cents < 1000000000),
  ADD CONSTRAINT settlements_escrow_identity
             CHECK (escrow_closing_cents = escrow_opening_cents - escrow_charges_cents
                                           + escrow_withheld_cents);

-- A draft whose lines no longer match their sources is parked, never paid. Only "Run the week"
-- clears a park, by recomputing the draft.
ALTER TABLE settlements
  ADD COLUMN parked_reason text CHECK (parked_reason ~ '^[a-z_]{2,40}$'),
  ADD COLUMN parked_at     timestamptz,
  ADD CONSTRAINT settlements_parked_pair  CHECK ((parked_reason IS NULL) = (parked_at IS NULL)),
  ADD CONSTRAINT settlements_parked_draft CHECK (parked_reason IS NULL OR status = 'draft');
CREATE INDEX settlements_tenant_parked ON settlements (tenant_id, period_id)
  WHERE parked_reason IS NOT NULL;
