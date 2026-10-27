-- SETTLEMENTS: the week's pay is run, checked against its sources, approved one paystub at a time
-- or all clean ones at once, paid out and booked. This file adds the approval batch, the batch
-- reference on the ledger row, the settlement_approve proposal kind, and the parity columns the
-- paid settlement and the driver carry (escrow as a running balance, the insurance exemption, and
-- the park a draft gets when its lines no longer match their sources).
--
-- Nothing here moves money. Every write to the outside world still goes through money_actions,
-- whose guard below learns one more column that never changes once written.

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
  'factoring_request', 'bill_defer', 'collections_chase'));

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

-- Escrow runs as a balance: a charge can take it below zero and withholding repays it. The
-- posted balance through the last paid settlement may be negative.
ALTER TABLE drivers DROP CONSTRAINT drivers_escrow_balance_cents_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_escrow_balance_cents_check
  CHECK (escrow_balance_cents > -1000000000 AND escrow_balance_cents < 1000000000);
-- Full list, as the kind check is re-created. An escrow_charge posts against escrow, never a line.
ALTER TABLE pay_items DROP CONSTRAINT pay_items_kind_check;
ALTER TABLE pay_items ADD CONSTRAINT pay_items_kind_check
  CHECK (kind IN ('fuel', 'reimbursement', 'other_deduction', 'carried_shortfall', 'escrow_charge'));
-- Identical to the sweep migration's statement (full union incl. proposals), so either order ends
-- the same.
ALTER TABLE pay_items DROP CONSTRAINT pay_items_ref_table_check;
ALTER TABLE pay_items ADD CONSTRAINT pay_items_ref_table_check
  CHECK (ref_table IS NULL OR ref_table IN ('fuel_purchases', 'load_accessorials', 'loads',
                                            'settlements', 'proposals'));

-- A driver who carries their own insurance pays no daily insurance charge. A flag read at run
-- time, so a change applies to the next run as a whole week.
ALTER TABLE drivers ADD COLUMN own_insurance boolean NOT NULL DEFAULT false;

-- What a paid settlement did to escrow: opening, charges posted, withheld, closing. A draft keeps
-- zeros until it is booked.
ALTER TABLE settlements
  ADD COLUMN escrow_opening_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_opening_cents > -1000000000 AND escrow_opening_cents < 1000000000),
  ADD COLUMN escrow_charges_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_charges_cents >= 0 AND escrow_charges_cents < 1000000000),
  ADD COLUMN escrow_withheld_cents bigint NOT NULL DEFAULT 0
             CHECK (escrow_withheld_cents >= 0 AND escrow_withheld_cents < 1000000000),
  ADD COLUMN escrow_closing_cents  bigint NOT NULL DEFAULT 0
             CHECK (escrow_closing_cents > -1000000000 AND escrow_closing_cents < 1000000000),
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
