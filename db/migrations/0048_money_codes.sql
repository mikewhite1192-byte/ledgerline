-- One-time money codes for a lumper or a repair at the dock (MONEY-CODE), and the money layer's two
-- new kinds. Nothing here moves money: a code is issued by the simulated card provider through
-- money_actions, reserved before the call and settled after it, and only after a person approves.
--
-- 1. money_codes: one row per code asked for. The code itself is never stored: the provider
--    derives it from the ledger row's request id and the record page asks for it; the row keeps
--    the last four digits and the provider's reference. A confirmed code puts two paystub lines
--    that net to zero (the code as a charge, the receipt as a reimbursement) and, for a lumper,
--    one billable lumper accessorial on the load; the row names the three. document_id,
--    voice_note_id, proposal_id and money_action_id are plain ids with no foreign key: those
--    tables are cleared by demo_reset_clear() while this one is seeded (an empty plan), so the
--    reset needs no new body. Every foreign key here points at a seeded table or a kept one.
CREATE TABLE money_codes (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id             uuid NOT NULL,
  load_id               uuid NOT NULL,
  purpose               text NOT NULL CHECK (purpose IN ('lumper', 'repair', 'other')),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  source_kind           text NOT NULL CHECK (source_kind IN ('document', 'voice_note', 'chat', 'form')),
  document_id           uuid,
  voice_note_id         uuid,
  receipt_total_cents   bigint CHECK (receipt_total_cents IS NULL OR receipt_total_cents > 0),
  proposal_id           uuid,
  money_action_id       uuid,
  membership_id         uuid NOT NULL,
  status                text NOT NULL DEFAULT 'issuing'
                        CHECK (status IN ('issuing', 'issued', 'failed', 'unknown', 'voided')),
  provider_ref          text CHECK (provider_ref IS NULL OR provider_ref ~ '^fcs_code_[0-9a-f]{24}$'),
  code_last4            text CHECK (code_last4 IS NULL OR code_last4 ~ '^[0-9]{4}$'),
  accessorial_id        uuid,
  charge_item_id        uuid,
  reimbursement_item_id uuid,
  issued_at             timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'issued') = (issued_at IS NOT NULL AND provider_ref IS NOT NULL AND code_last4 IS NOT NULL)),
  CHECK (status = 'issued' OR (accessorial_id IS NULL AND charge_item_id IS NULL AND reimbursement_item_id IS NULL)),
  CHECK ((status = 'issued') = (charge_item_id IS NOT NULL AND reimbursement_item_id IS NOT NULL)),
  CHECK (accessorial_id IS NULL OR purpose = 'lumper'),
  CHECK (expires_at IS NULL OR (issued_at IS NOT NULL AND expires_at > issued_at)),
  CHECK ((source_kind = 'document') = (document_id IS NOT NULL)),
  CHECK ((source_kind = 'voice_note') = (voice_note_id IS NOT NULL)),
  CHECK (receipt_total_cents IS NULL OR source_kind = 'document'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, accessorial_id) REFERENCES load_accessorials (tenant_id, id),
  FOREIGN KEY (tenant_id, charge_item_id) REFERENCES pay_items (tenant_id, id),
  FOREIGN KEY (tenant_id, reimbursement_item_id) REFERENCES pay_items (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX money_codes_tenant_driver_day ON money_codes (tenant_id, driver_id, created_at);
CREATE INDEX money_codes_tenant_load ON money_codes (tenant_id, load_id);
-- One code per approval: the same proposal approved twice finds the row the first run made.
CREATE UNIQUE INDEX money_codes_one_per_proposal ON money_codes (tenant_id, proposal_id)
  WHERE proposal_id IS NOT NULL;
ALTER TABLE money_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON money_codes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE is for the seed's replace mode, which empties every seeded table before it writes the
-- plan back (the code rows go before the pay items and accessorials they name). The app itself
-- never deletes a code; a code a person calls off is 'voided'.
GRANT SELECT, INSERT, UPDATE, DELETE ON money_codes TO payday_app;

-- 2. The money layer's kinds, subjects, systems and pairings. 0047 (FACTORING) carries this same
--    block word for word, so whichever of the two runs last (production applies migrations in
--    merge order, a fresh database in number order) leaves the same constraints. Every list is the
--    full union; a later migration that re-creates any of them must carry these lists whole.
--    The pairings were unnamed table CHECKs in 0006, so Postgres named them money_actions_check2
--    (channel), money_actions_check5 (invoice and its subject) and money_actions_check7
--    (counterparty); each is dropped by that name, or by the name a run of this block gave it.
--      factoring_advance  payment, subject invoices, counterparty customers (no rail)
--      money_code_issue   payment, subject money_codes, counterparty drivers (no rail)
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_kind_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_kind_check
  CHECK (kind IN ('advance_payout', 'advance_expense', 'settlement_payout', 'settlement_bill',
                  'settlement_bill_payment', 'invoice', 'customer_payment', 'factoring_advance',
                  'money_code_issue'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_subject_table_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_subject_table_check
  CHECK (subject_table IN ('advances', 'settlements', 'invoices', 'customer_payments', 'money_codes'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_outside_system_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_outside_system_check
  CHECK (outside_system IN ('mock', 'stripe_test', 'qbo_sandbox', 'fuel_card_sim', 'factoring_sim'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_check2;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_channel_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_channel_pairing
  CHECK ((channel = 'payment') = (kind IN ('advance_payout', 'settlement_payout', 'factoring_advance',
                                           'money_code_issue')));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_check5;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_invoice_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_invoice_subject_pairing
  CHECK ((kind IN ('invoice', 'factoring_advance')) = (subject_table = 'invoices'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_money_code_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_money_code_subject_pairing
  CHECK ((kind = 'money_code_issue') = (subject_table = 'money_codes'));
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_check7;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_counterparty_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_counterparty_pairing
  CHECK ((counterparty_table = 'customers') = (kind IN ('invoice', 'customer_payment', 'factoring_advance')));

-- 3. proposals_kind_check, the full union of every proposal kind known across all branches
--    (memory: proposal-kind-check-union): main's 12 from 0032, plus card_match (0046, CARD-RECON)
--    and money_code (this one). A kind with no code yet is harmless in an allow list. Whichever of
--    0029, 0030, 0046 and 0048 runs last decides the check, so each lists all 14.
--    proposals_subject_table_check is not touched: a money code's proposal names its load.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code'));
