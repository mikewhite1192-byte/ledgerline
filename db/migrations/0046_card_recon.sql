-- CARD CHECK: the card provider's statement, the bank and the books compared with our own payment
-- records. This file adds the card provider's statement (Test mode: seeded rows, the simulated
-- provider appends nothing), one row per check a person starts, and one row per difference found
-- (a "break"), plus the card_match proposal kind and its subject table.
--
-- Nothing here moves money. A check reads the statement and reads each payment record back from
-- its own system; it writes only these tables. Approving a card match adds the card to the
-- driver's identity map and records the fuel purchase, both our own rows.
--
-- The demo reset: all three tables are seeded tables (the seed's replace clears and rewrites them
-- as the app role, the cash_checks precedent), so demo_reset_clear() is not re-created. Their
-- foreign keys reach only seeded tables, tenants and memberships (kept by the reset); the ledger
-- row and the proposal a break names are plain id columns, since the function clears those first.

-- The card provider's statement: what its portal shows. A fuel row's reference is the purchase
-- reference the carrier's records use (the seeded purchases' own form); a card load's reference
-- is the simulated provider's load id, the form its read-back returns.
CREATE TABLE card_transactions (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('fuel_card_sim')),
  provider_ref  text NOT NULL CHECK (provider_ref ~ '^[a-z0-9_-]{3,64}$'),
  kind          text NOT NULL CHECK (kind IN ('fuel', 'load')),
  card_token    text NOT NULL CHECK (card_token ~ '^fcs_card_[0-9a-f]{24}$'),
  card_last4    text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  portal_name   text NOT NULL CHECK (portal_name ~ '^[A-Z0-9 -]{2,40}$'),
  posted_at     timestamptz NOT NULL,
  posted_on     date NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  state         char(2) CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  gallons_milli integer CHECK (gallons_milli IS NULL OR (gallons_milli > 0 AND gallons_milli < 1000000)),
  merchant      text CHECK (merchant IS NULL OR length(merchant) BETWEEN 1 AND 60),
  source        text NOT NULL CHECK (source IN ('seed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'fuel') = (state IS NOT NULL AND gallons_milli IS NOT NULL)),
  CHECK (kind <> 'load' OR provider_ref ~ '^fcs_load_[0-9a-f]{24}$'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_ref)
);
CREATE INDEX card_transactions_tenant_on ON card_transactions (tenant_id, posted_on);
ALTER TABLE card_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON card_transactions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- INSERT and DELETE serve only the seed's replace (and so the demo reset), which runs as the app
-- role; no app path writes a statement row, and none updates one.
GRANT SELECT, INSERT, DELETE ON card_transactions TO payday_app;

-- One check a person started. At most one runs per carrier at a time. A check runs in slices of
-- one request each (the sweep's pattern): the slice holding the lease (lease_token until
-- lease_until) is the only one that writes, `todo` holds the payment records still to read back,
-- and `phase` says what the next slice does.
CREATE TABLE card_recon_runs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id  uuid NOT NULL,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  phase          text NOT NULL DEFAULT 'read' CHECK (phase IN ('read', 'explain', 'match', 'done')),
  todo           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(todo) = 'array'),
  lease_token    uuid,
  lease_until    timestamptz,
  fail_category  text CHECK (fail_category IS NULL OR fail_category ~ '^[a-z_:]{2,40}$'),
  window_from    date NOT NULL,
  window_to      date NOT NULL,
  counts         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  unchecked      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(unchecked) = 'array'),
  model_cents    integer NOT NULL DEFAULT 0 CHECK (model_cents >= 0),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status = 'running' OR (lease_token IS NULL AND jsonb_array_length(todo) = 0)),
  CHECK (window_to >= window_from),
  UNIQUE (tenant_id, id),
  CONSTRAINT card_recon_runs_membership_fk
    FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE UNIQUE INDEX card_recon_one_running ON card_recon_runs (tenant_id) WHERE status = 'running';
ALTER TABLE card_recon_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_recon_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON card_recon_runs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE serves only the seed's replace (the demo reset); no app path deletes a run.
GRANT SELECT, INSERT, DELETE ON card_recon_runs TO payday_app;
GRANT UPDATE (status, phase, todo, lease_token, lease_until, fail_category, counts, unchecked,
              model_cents, finished_at)
  ON card_recon_runs TO payday_app;

-- One difference between our records and an outside system, deduped across checks by its
-- fingerprint (sha256 of the category and the ids it names).
CREATE TABLE card_recon_breaks (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fingerprint         text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  category            text NOT NULL CHECK (category IN ('fuel_amount_differs', 'purchase_not_recorded',
                        'card_unknown', 'load_not_in_ledger', 'load_amount_differs', 'missing_outside',
                        'reversed_outside', 'amount_differs_outside', 'pending_outside', 'not_confirmed')),
  severity            text NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  outside_system      text CHECK (outside_system IN ('fuel_card_sim', 'stripe_test', 'qbo_sandbox', 'mock')),
  card_transaction_id uuid,
  money_action_id     uuid,            -- no FK: demo_reset_clear() clears the ledger first
  fuel_purchase_id    uuid,
  driver_id           uuid,
  our_cents           bigint CHECK (our_cents IS NULL OR our_cents >= 0),
  outside_cents       bigint CHECK (outside_cents IS NULL OR outside_cents >= 0),
  explanation         text CHECK (explanation IS NULL OR length(explanation) BETWEEN 1 AND 600),
  explain_category    text CHECK (explain_category IS NULL OR explain_category ~ '^[a-z_]{2,40}$'),
  fix_kind            text NOT NULL CHECK (fix_kind IN ('card_match', 'check_pending', 'retry', 'by_hand', 'none')),
  proposal_id         uuid,            -- no FK: demo_reset_clear() clears proposals first
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  dismiss_category    text CHECK (dismiss_category IS NULL OR dismiss_category IN ('explained', 'duplicate', 'wrong_system', 'other')),
  first_seen_run_id   uuid NOT NULL,
  last_seen_run_id    uuid NOT NULL,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'dismissed') = (dismiss_category IS NOT NULL)),
  CHECK (status = 'open' OR resolved_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fingerprint),
  CONSTRAINT card_recon_breaks_txn_fk FOREIGN KEY (tenant_id, card_transaction_id)
    REFERENCES card_transactions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT card_recon_breaks_purchase_fk FOREIGN KEY (tenant_id, fuel_purchase_id)
    REFERENCES fuel_purchases (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT card_recon_breaks_driver_fk FOREIGN KEY (tenant_id, driver_id)
    REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT card_recon_breaks_first_run_fk FOREIGN KEY (tenant_id, first_seen_run_id)
    REFERENCES card_recon_runs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT card_recon_breaks_last_run_fk FOREIGN KEY (tenant_id, last_seen_run_id)
    REFERENCES card_recon_runs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX card_recon_breaks_open ON card_recon_breaks (tenant_id, status, severity);
ALTER TABLE card_recon_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_recon_breaks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON card_recon_breaks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE serves only the seed's replace (the demo reset); no app path deletes a break, so a
-- dismissed or resolved break stays on the record.
GRANT SELECT, INSERT, DELETE ON card_recon_breaks TO payday_app;
GRANT UPDATE (severity, outside_system, driver_id, our_cents, outside_cents, explanation,
              explain_category, fix_kind, proposal_id, status, dismiss_category, last_seen_run_id,
              resolved_at, updated_at)
  ON card_recon_breaks TO payday_app;

-- The card match rides the proposal kind list. Re-created constraints list the full union of every
-- kind in flight (0029 and 0030 add four, 0048 adds money_code), so whichever of these files runs
-- last, in production order or in number order, every kind is allowed.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code'));

-- A card match's subject is the statement row. The list is 0029's (vendor_bills) plus this one.
ALTER TABLE proposals DROP CONSTRAINT proposals_subject_table_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_subject_table_check
  CHECK (subject_table IN ('customers', 'drivers', 'loads', 'load_state_miles', 'load_accessorials',
                           'driver_days', 'fuel_purchases', 'pay_configs', 'deduction_schedules',
                           'pay_items', 'advances', 'settlement_periods', 'settlements',
                           'settlement_lines', 'invoices', 'customer_payments',
                           'payment_applications', 'vendor_bills', 'card_transactions'));
