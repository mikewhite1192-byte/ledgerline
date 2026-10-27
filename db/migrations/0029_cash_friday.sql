-- Cash Friday: the Cash page answers whether the bank covers Friday's pay run, the fuel card loads
-- not yet out and the bills due by then, and drafts up to three ways to close a short (factor some
-- invoices, delay a flexible bill, chase late payers) for a person to approve. The rules engine
-- computes every figure in integer cents; nothing here moves money or writes outside these tables.
--
-- 1. One row per carrier: the seeded bank position and the factoring terms (synthetic).
CREATE TABLE cash_settings (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_balance_cents    bigint NOT NULL
                          CHECK (bank_balance_cents > -1000000000 AND bank_balance_cents < 1000000000),
  balance_as_of         date NOT NULL,
  pay_day_dow           smallint NOT NULL DEFAULT 5 CHECK (pay_day_dow BETWEEN 0 AND 6),
  factoring_advance_bps integer NOT NULL DEFAULT 9000 CHECK (factoring_advance_bps BETWEEN 5000 AND 10000),
  factoring_fee_bps     integer NOT NULL DEFAULT 300 CHECK (factoring_fee_bps BETWEEN 0 AND 1000),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE cash_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_settings
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- A seeded table: the seed's replace deletes and re-inserts it.
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_settings TO payday_app;

-- 2. Bills the carrier owes, the minimum the "delay a bill" option needs. Invented vendors only.
--    A bill is open, deferred to a later date by an approved card (proposal_id names it), or paid.
--    Deleting the proposal (a reseed clears the agent's rows first) only clears the link.
CREATE TABLE vendor_bills (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bill_ref     text NOT NULL CHECK (bill_ref ~ '^[A-Z0-9-]{3,30}$'),
  vendor_name  text NOT NULL CHECK (length(vendor_name) BETWEEN 1 AND 80),
  category     text NOT NULL CHECK (category IN ('fuel_supplier', 'insurance', 'maintenance', 'tolls',
                 'software', 'lease', 'other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  due_on       date NOT NULL,
  urgency      text NOT NULL CHECK (urgency IN ('fixed', 'flexible')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'deferred', 'paid')),
  deferred_to  date,
  paid_on      date,
  proposal_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'deferred') = (deferred_to IS NOT NULL)),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
  CHECK (deferred_to IS NULL OR deferred_to > due_on),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bill_ref),
  CONSTRAINT vendor_bills_proposal_fk FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id)
    ON DELETE SET NULL (proposal_id)
);
CREATE INDEX vendor_bills_tenant_due ON vendor_bills (tenant_id, status, due_on);
ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_bills
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- A seeded table (replace deletes it); the bill_defer executor's one UPDATE is covered here too.
GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_bills TO payday_app;

-- 3. One row per check: the figures a person saw, the option cards it made, and the explanation
--    (or the category of why there is none). The replace clears these with the seeded tables,
--    before the week a check names.
CREATE TABLE cash_checks (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id        uuid NOT NULL,
  as_of            date NOT NULL,
  pay_day          date NOT NULL,
  figures          jsonb NOT NULL CHECK (jsonb_typeof(figures) = 'object'),
  lines            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(lines) = 'array'),
  options          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  gap_cents        bigint NOT NULL,
  pay_run_source   text NOT NULL CHECK (pay_run_source IN ('stored', 'preview')),
  explanation      text CHECK (length(explanation) <= 600),
  explain_call_id  uuid,
  explain_category text CHECK (explain_category ~ '^[a-z_]{2,40}$'),
  created_by       text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (explanation IS NULL OR explain_category IS NULL),
  UNIQUE (tenant_id, id),
  CONSTRAINT cash_checks_period_fk FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id)
);
CREATE INDEX cash_checks_tenant_created ON cash_checks (tenant_id, created_at DESC);
ALTER TABLE cash_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_checks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, DELETE ON cash_checks TO payday_app;
GRANT UPDATE (explanation, explain_call_id, explain_category, options) ON cash_checks TO payday_app;

-- 4. The proposal kinds factoring_request, bill_defer and collections_chase. 0009 declared the kind
--    check inline, so Postgres named it proposals_kind_check. The list below is the full union of
--    every proposal kind known across all branches, in this order, whether or not its code has
--    merged yet: a kind with no code is harmless in an allow list. 0013, 0015 and 0022 also
--    re-create this check, so whichever runs last decides it (production applies migrations in
--    merge order, a fresh database in number order); this one runs after all of them either way.
--    Any later migration that adds a kind re-lists them all, this one included. A static test
--    (src/lib/proposals/kind-check-migrations.test.ts) fails when the newest re-creation misses
--    a kind the code knows.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
                  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request',
                  'bill_defer', 'collections_chase', 'pay_rule_change'));

-- 5. A bill can now be a card's subject. 0009 declared the subject list inline (Postgres named it
--    proposals_subject_table_check) and no migration has changed it since; this is that list
--    with vendor_bills added.
ALTER TABLE proposals DROP CONSTRAINT proposals_subject_table_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_subject_table_check
  CHECK (subject_table IN ('customers', 'drivers', 'loads', 'load_state_miles', 'load_accessorials',
                           'driver_days', 'fuel_purchases', 'pay_configs', 'deduction_schedules',
                           'pay_items', 'advances', 'settlement_periods', 'settlements',
                           'settlement_lines', 'invoices', 'customer_payments',
                           'payment_applications', 'vendor_bills'));
