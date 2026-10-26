-- A carrier's operations: customers, drivers, loads with their miles by state and accessorials,
-- the days each driver worked, and fuel purchases with state and gallons (the IFTA inputs).
--
-- Every table follows db/README.md: tenant_id, ENABLE and FORCE row-level security, the one
-- tenant_isolation policy and the app grant. Ids are made by the app (the Data API returns no
-- rows from INSERT ... RETURNING). A reference to another tenant table is a composite foreign key
-- on (tenant_id, x_id), so a row can never point at another tenant's row. Money is bigint cents;
-- calendar facts are tenant-local dates; miles are whole and gallons are thousandths.

CREATE TABLE customers (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  name       text NOT NULL,
  terms_days integer NOT NULL CHECK (terms_days IN (15, 30, 45)),
  city       text NOT NULL,
  state      char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Exactly the rate column that matches pay_basis is set: per mile for company drivers on the
-- road, a percent of the load for owner-operators, a flat amount per load for local runs.
CREATE TABLE drivers (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                 text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text NOT NULL,
  worker_type          text NOT NULL CHECK (worker_type IN ('company', 'owner_operator')),
  pay_basis            text NOT NULL CHECK (pay_basis IN ('per_mile', 'percent', 'flat')),
  per_mile_cents       integer CHECK (per_mile_cents > 0 AND per_mile_cents < 1000),
  percent_bps          integer CHECK (percent_bps > 0 AND percent_bps <= 10000),
  flat_per_load_cents  bigint CHECK (flat_per_load_cents > 0 AND flat_per_load_cents < 1000000000),
  -- NULL means the tenant's advance_limit_default_cents.
  advance_limit_cents  bigint
                       CHECK (advance_limit_cents >= 0 AND advance_limit_cents < 1000000000),
  escrow_balance_cents bigint NOT NULL DEFAULT 0
                       CHECK (escrow_balance_cents >= 0 AND escrow_balance_cents < 1000000000),
  truck_unit           text,
  active_from          date NOT NULL,
  active_to            date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((pay_basis = 'per_mile') = (per_mile_cents IS NOT NULL)
     AND (pay_basis = 'percent') = (percent_bps IS NOT NULL)
     AND (pay_basis = 'flat') = (flat_per_load_cents IS NOT NULL)),
  CHECK (active_to IS NULL OR active_to >= active_from),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, email)
);
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drivers
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- linehaul_cents may be NULL: a delivered load whose rate never arrived is an exception for the
-- engine, never a zero. delivered_on is the tenant-local date of delivered_at.
CREATE TABLE loads (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_number          text NOT NULL,
  customer_id          uuid NOT NULL,
  driver_id            uuid,
  status               text NOT NULL
                       CHECK (status IN ('planned', 'in_transit', 'delivered', 'invoiced', 'cancelled')),
  origin_city          text NOT NULL,
  origin_state         char(2) NOT NULL CHECK (origin_state ~ '^[A-Z]{2}$'),
  dest_city            text NOT NULL,
  dest_state           char(2) NOT NULL CHECK (dest_state ~ '^[A-Z]{2}$'),
  pickup_on            date NOT NULL,
  delivered_on         date,
  delivered_at         timestamptz,
  loaded_miles         integer NOT NULL CHECK (loaded_miles >= 0 AND loaded_miles < 10000),
  empty_miles          integer NOT NULL DEFAULT 0 CHECK (empty_miles >= 0 AND empty_miles < 10000),
  linehaul_cents       bigint CHECK (linehaul_cents >= 0 AND linehaul_cents < 1000000000),
  fuel_surcharge_cents bigint NOT NULL DEFAULT 0
                       CHECK (fuel_surcharge_cents >= 0 AND fuel_surcharge_cents < 1000000000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('delivered', 'invoiced') OR (delivered_on IS NOT NULL AND driver_id IS NOT NULL)),
  CHECK ((delivered_on IS NULL) = (delivered_at IS NULL)),
  CHECK (delivered_on IS NULL OR delivered_on >= pickup_on),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, load_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
);
CREATE INDEX loads_tenant_delivered_on_idx ON loads (tenant_id, delivered_on);
CREATE INDEX loads_tenant_driver_idx ON loads (tenant_id, driver_id);
ALTER TABLE loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE loads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loads
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One row per state a load drove through. The rows of a load sum to loaded_miles + empty_miles;
-- that is a sum across rows, so the seed and the engine assert it rather than a CHECK.
CREATE TABLE load_state_miles (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id    uuid NOT NULL,
  state      char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  miles      integer NOT NULL CHECK (miles > 0 AND miles < 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, load_id, state),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
ALTER TABLE load_state_miles ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_state_miles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON load_state_miles
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Only a lumper can be paid by the driver (then the driver is owed a reimbursement).
CREATE TABLE load_accessorials (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('detention', 'layover', 'stop', 'lumper')),
  seq            integer NOT NULL CHECK (seq > 0),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  paid_by_driver boolean NOT NULL DEFAULT false,
  description    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT paid_by_driver OR kind = 'lumper'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, load_id, kind, seq),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
ALTER TABLE load_accessorials ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_accessorials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON load_accessorials
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A day a driver worked. The unique key is the "one charge per day" rule for per-day deductions.
CREATE TABLE driver_days (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id  uuid NOT NULL,
  day        date NOT NULL,
  source     text NOT NULL CHECK (source IN ('load', 'dispatch')),
  load_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'dispatch' OR load_id IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, driver_id, day),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
ALTER TABLE driver_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_days
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Every gallon a truck bought, whoever paid: the state and gallons are what IFTA needs.
CREATE TABLE fuel_purchases (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL,
  load_id       uuid,
  purchased_at  timestamptz NOT NULL,
  purchased_on  date NOT NULL,
  state         char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  gallons_milli integer NOT NULL CHECK (gallons_milli > 0 AND gallons_milli < 1000000),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  paid_with     text NOT NULL CHECK (paid_with IN ('company_card', 'driver_own')),
  purchase_ref  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_ref),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
CREATE INDEX fuel_purchases_tenant_driver_on_idx ON fuel_purchases (tenant_id, driver_id, purchased_on);
ALTER TABLE fuel_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fuel_purchases
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON customers, drivers, loads, load_state_miles, load_accessorials, driver_days, fuel_purchases
  TO payday_app;
