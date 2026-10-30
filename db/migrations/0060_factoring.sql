-- Invoices sold to a simulated factoring partner (FACTORING), and the money layer's two new kinds.
-- Nothing here moves money: each invoice's advance comes from the simulated partner through
-- money_actions, reserved before the call and settled after it, and only after a person approves.
--
-- 1. factoring_requests: one row per approved "Factor these invoices" card, holding the totals
--    the rules engine computed (advance = balance x advance rate, fee = balance x fee rate,
--    net = advance - fee, reserve = balance - advance, all integer cents). factoring_request_invoices:
--    one line per invoice with its own numbers, the packet snapshot (which of invoice, rate
--    confirmation, bill of lading and POD were on file), the partner's reference and its own
--    status. Each line is written before its ledger row is reserved, so a crash leaves a marker
--    the next approval or Check pending adopts. proposal_id and money_action_id are plain ids with
--    no foreign key: those tables are cleared by demo_reset_clear() while these two are seeded (an
--    empty plan), so the reset needs no new body. Every foreign key here points at a seeded table
--    or a kept one.
CREATE TABLE factoring_requests (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id       uuid NOT NULL,
  proposal_id     uuid,
  membership_id   uuid NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('factoring_sim')),
  advance_bps     integer NOT NULL CHECK (advance_bps BETWEEN 5000 AND 10000),
  fee_bps         integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  balance_cents   bigint NOT NULL CHECK (balance_cents > 0 AND balance_cents < 1000000000),
  advance_cents   bigint NOT NULL CHECK (advance_cents >= 0),
  fee_cents       bigint NOT NULL CHECK (fee_cents >= 0),
  net_cents       bigint NOT NULL CHECK (net_cents > 0),
  reserve_cents   bigint NOT NULL CHECK (reserve_cents >= 0),
  status          text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'funded', 'partly_funded', 'declined', 'unknown', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  funded_at       timestamptz,
  CHECK (net_cents = advance_cents - fee_cents AND reserve_cents = balance_cents - advance_cents),
  CHECK (funded_at IS NULL OR status IN ('funded', 'partly_funded')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX factoring_requests_tenant_created ON factoring_requests (tenant_id, created_at);
-- One request per approval: the same card approved twice finds the request the first run made.
CREATE UNIQUE INDEX factoring_requests_one_per_proposal ON factoring_requests (tenant_id, proposal_id)
  WHERE proposal_id IS NOT NULL;
ALTER TABLE factoring_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE factoring_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factoring_requests
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE is for the seed's replace mode, which empties every seeded table before it writes the
-- plan back. The app itself never deletes a request.
GRANT SELECT, INSERT, UPDATE, DELETE ON factoring_requests TO payday_app;

-- attempt is the line's ledger try (the ledger key factoring_advance:<invoice id>:<attempt>): one
-- more than any earlier line for the same invoice, so a declined invoice factored again later
-- never replays the declined row.
CREATE TABLE factoring_request_invoices (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id      uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  attempt         smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  balance_cents   bigint NOT NULL CHECK (balance_cents > 0 AND balance_cents < 1000000000),
  advance_cents   bigint NOT NULL CHECK (advance_cents >= 0),
  fee_cents       bigint NOT NULL CHECK (fee_cents >= 0),
  net_cents       bigint NOT NULL CHECK (net_cents > 0),
  reserve_cents   bigint NOT NULL CHECK (reserve_cents >= 0),
  money_action_id uuid,
  provider_ref    text CHECK (provider_ref IS NULL OR provider_ref ~ '^fsim_adv_[0-9a-f]{24}$'),
  status          text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'funded', 'declined', 'unknown', 'failed')),
  packet          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(packet) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  CHECK (net_cents = advance_cents - fee_cents AND reserve_cents = balance_cents - advance_cents),
  CHECK ((status = 'funded') = (provider_ref IS NOT NULL)),
  CHECK (status <> 'funded' OR settled_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES factoring_requests (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX factoring_request_invoices_tenant_request ON factoring_request_invoices (tenant_id, request_id);
-- An invoice is factored at most once at a time: a second live line for it is refused whatever
-- path writes it (the ledger's one live row per subject guards the money the same way).
CREATE UNIQUE INDEX factoring_one_live_per_invoice ON factoring_request_invoices (tenant_id, invoice_id)
  WHERE status NOT IN ('declined', 'failed');
CREATE UNIQUE INDEX factoring_request_invoices_attempt ON factoring_request_invoices (tenant_id, invoice_id, attempt);
CREATE UNIQUE INDEX factoring_request_invoices_money_action ON factoring_request_invoices (tenant_id, money_action_id)
  WHERE money_action_id IS NOT NULL;
ALTER TABLE factoring_request_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE factoring_request_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON factoring_request_invoices
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE is for the seed's replace mode, as above.
GRANT SELECT, INSERT, UPDATE, DELETE ON factoring_request_invoices TO payday_app;

-- 2. The money layer's kinds, subjects, systems and pairings. 0048 (MONEY-CODE) carries this same
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
