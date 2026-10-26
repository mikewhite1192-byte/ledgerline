-- How a carrier pays drivers and bills customers: the per-tenant pay rules, standing deductions,
-- pay items (fuel, reimbursements, one-off deductions), advances, weekly settlements with their
-- paystub lines, and receivables (invoices, customer payments and how each payment was applied).
--
-- Same conventions as 0004: tenant_id, forced row-level security with the one policy, the app
-- grant, app-made ids, composite (tenant_id, x_id) foreign keys, bigint cents, local dates.
-- Nothing here moves money: these rows record what the rules engine computed and what arrived.

-- One row per version of a tenant's pay rules. A version applies from the first period that
-- starts on or after effective_from; week_start_dow is the same on every version (checked in code).
-- Every knob the rules engine reads, range-checked here and again in code.
CREATE TABLE pay_configs (
  id                           uuid PRIMARY KEY,
  tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  effective_from               date NOT NULL,
  note                         text,
  source                       text NOT NULL CHECK (source IN ('seed', 'ui')),
  week_start_dow               integer NOT NULL CHECK (week_start_dow BETWEEN 0 AND 6),
  percent_base                 text NOT NULL
                               CHECK (percent_base IN ('linehaul', 'linehaul_fsc', 'linehaul_fsc_accessorials')),
  empty_miles_paid_bps         integer NOT NULL CHECK (empty_miles_paid_bps BETWEEN 0 AND 10000),
  accessorial_driver_share_bps integer NOT NULL CHECK (accessorial_driver_share_bps BETWEEN 0 AND 10000),
  insurance_applies_to         text NOT NULL CHECK (insurance_applies_to IN ('owner_operator', 'all')),
  insurance_per_day_cents      bigint NOT NULL
                               CHECK (insurance_per_day_cents >= 0 AND insurance_per_day_cents < 1000000000),
  escrow_target_cents          bigint NOT NULL
                               CHECK (escrow_target_cents >= 0 AND escrow_target_cents < 1000000000),
  escrow_per_settlement_cents  bigint NOT NULL
                               CHECK (escrow_per_settlement_cents >= 0 AND escrow_per_settlement_cents < 1000000000),
  net_pay_floor_cents          bigint NOT NULL
                               CHECK (net_pay_floor_cents >= 0 AND net_pay_floor_cents < 1000000000),
  -- NULL recovers every outstanding advance each settlement (still limited by the pay floor).
  advance_recovery_cap_cents   bigint
                               CHECK (advance_recovery_cap_cents >= 0 AND advance_recovery_cap_cents < 1000000000),
  advance_fee_cents            bigint NOT NULL
                               CHECK (advance_fee_cents >= 0 AND advance_fee_cents < 1000000000),
  advance_limit_default_cents  bigint NOT NULL
                               CHECK (advance_limit_default_cents >= 0 AND advance_limit_default_cents < 1000000000),
  advance_max_bps_of_earned    integer NOT NULL CHECK (advance_max_bps_of_earned BETWEEN 0 AND 10000),
  advance_min_cents            bigint NOT NULL
                               CHECK (advance_min_cents >= 0 AND advance_min_cents < 1000000000),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, effective_from)
);
ALTER TABLE pay_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_configs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Standing deductions taken each settlement while active. Only escrow has a target; NULL there
-- means the tenant's escrow_target_cents.
CREATE TABLE deduction_schedules (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('escrow', 'lease', 'other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  target_cents bigint CHECK (target_cents > 0 AND target_cents < 1000000000),
  description  text NOT NULL,
  active_from  date NOT NULL,
  active_to    date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'escrow' OR target_cents IS NULL),
  CHECK (active_to IS NULL OR active_to >= active_from),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, driver_id, kind, active_from),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
);
ALTER TABLE deduction_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE deduction_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deduction_schedules
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Weekly pay periods in the tenant's week shape: seven local dates, start to end inclusive.
CREATE TABLE settlement_periods (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       text NOT NULL CHECK (status IN ('open', 'approved', 'paid')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end = period_start + 6),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_start)
);
ALTER TABLE settlement_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_periods
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One driver's pay for one period, as the rules engine computed it.
CREATE TABLE settlements (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id           uuid NOT NULL,
  driver_id           uuid NOT NULL,
  -- The pay rules version this settlement was computed under.
  pay_config_id       uuid NOT NULL,
  status              text NOT NULL CHECK (status IN ('draft', 'approved', 'paid')),
  gross_cents         bigint NOT NULL CHECK (gross_cents >= 0 AND gross_cents < 1000000000),
  deductions_cents    bigint NOT NULL CHECK (deductions_cents >= 0 AND deductions_cents < 1000000000),
  net_cents           bigint NOT NULL CHECK (net_cents >= 0 AND net_cents < 1000000000),
  carry_forward_cents bigint NOT NULL DEFAULT 0
                      CHECK (carry_forward_cents >= 0 AND carry_forward_cents < 1000000000),
  exception_count     integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, period_id, driver_id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_config_id) REFERENCES pay_configs (tenant_id, id)
);
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlements
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A paystub line. sources is the array of { table, id } records the line was computed from.
CREATE TABLE settlement_lines (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  seq           integer NOT NULL CHECK (seq > 0),
  kind          text NOT NULL CHECK (kind IN ('load_pay', 'accessorial_pay', 'reimbursement', 'fuel',
                  'other_deduction', 'carried_shortfall', 'lease', 'insurance', 'escrow', 'advance_recovery')),
  label         text NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > -1000000000 AND amount_cents < 1000000000),
  sources       jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  meta          jsonb CHECK (jsonb_typeof(meta) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, settlement_id, seq),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES settlements (tenant_id, id)
);
ALTER TABLE settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_lines
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A positive amount; the kind gives the sign (a reimbursement adds, the others deduct). ref_table
-- and ref_id name the record the item came from, when there is one.
CREATE TABLE pay_items (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL,
  kind          text NOT NULL
                CHECK (kind IN ('fuel', 'reimbursement', 'other_deduction', 'carried_shortfall')),
  subkind       text NOT NULL CHECK (subkind ~ '^[a-z_]{2,40}$'),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  item_date     date NOT NULL,
  ref_table     text CHECK (ref_table IN ('fuel_purchases', 'load_accessorials', 'loads', 'settlements')),
  ref_id        uuid,
  item_ref      text NOT NULL,
  description   text NOT NULL,
  settlement_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((ref_table IS NULL) = (ref_id IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_ref),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES settlements (tenant_id, id)
);
CREATE INDEX pay_items_tenant_driver_date_idx ON pay_items (tenant_id, driver_id, item_date);
ALTER TABLE pay_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_items
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Cash a driver took against future pay. recovered_cents grows as settlements take it back.
CREATE TABLE advances (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL,
  request_ref     text NOT NULL,
  requested_at    timestamptz NOT NULL,
  requested_on    date NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  fee_cents       bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0 AND fee_cents < 1000000000),
  status          text NOT NULL
                  CHECK (status IN ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
  recovered_cents bigint NOT NULL DEFAULT 0
                  CHECK (recovered_cents >= 0 AND recovered_cents < 1000000000),
  source          text NOT NULL CHECK (source IN ('ui', 'email', 'seed')),
  -- Why a request was refused, as a category; never free text from the request.
  reason_category text CHECK (reason_category ~ '^[a-z_]{2,40}$'),
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (recovered_cents <= amount_cents + fee_cents),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_ref),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
);
CREATE INDEX advances_tenant_driver_status_idx ON advances (tenant_id, driver_id, status);
ALTER TABLE advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE advances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON advances
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- What a customer owes. A load invoice has its load; an opening invoice is a receivable carried
-- in from before the app, with no load. status is stored (the aging index reads it) and must
-- equal what the payment applications add up to; that sum spans rows, so tests check it.
CREATE TABLE invoices (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source         text NOT NULL CHECK (source IN ('load', 'opening')),
  load_id        uuid,
  customer_id    uuid NOT NULL,
  invoice_number text NOT NULL,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  issued_on      date NOT NULL,
  due_on         date NOT NULL,
  status         text NOT NULL CHECK (status IN ('open', 'partially_paid', 'paid', 'void')),
  paid_on        date,
  qbo_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'opening' OR load_id IS NOT NULL),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
  CHECK (due_on >= issued_on),
  CHECK (paid_on IS NULL OR paid_on >= issued_on),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, load_id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX invoices_tenant_status_due_idx ON invoices (tenant_id, status, due_on);
CREATE INDEX invoices_tenant_customer_idx ON invoices (tenant_id, customer_id);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A check, ACH or wire that arrived from a customer. Recorded only: nothing here collects money.
CREATE TABLE customer_payments (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,
  received_on  date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  method       text NOT NULL CHECK (method IN ('check', 'ach', 'wire')),
  payment_ref  text NOT NULL,
  source       text NOT NULL CHECK (source IN ('ui', 'email', 'seed')),
  memo         text,
  qbo_id       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_ref),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX customer_payments_tenant_received_idx ON customer_payments (tenant_id, received_on);
CREATE INDEX customer_payments_tenant_customer_idx ON customer_payments (tenant_id, customer_id);
ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_payments
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- How much of a payment went to which invoice. No CHECK stops an invoice from being applied past
-- its amount: that is how a payment posted to the wrong invoice shows up, so a check finds it.
-- The unique key also serves lookups by payment.
CREATE TABLE payment_applications (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id   uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_id, invoice_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES customer_payments (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE INDEX payment_applications_tenant_invoice_idx ON payment_applications (tenant_id, invoice_id);
ALTER TABLE payment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_applications
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON pay_configs, deduction_schedules, settlement_periods, settlements, settlement_lines,
     pay_items, advances, invoices, customer_payments, payment_applications
  TO payday_app;
