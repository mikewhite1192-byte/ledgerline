-- Advance parity: a driver is armed to receive money or not (separate from the card), the ids
-- other systems know a driver by, several fuel cards per driver with one default, the load an
-- advance is for, a take-back, and a per-load cap on advances. Same conventions as 0004 to 0017:
-- the tenant on every row, composite foreign keys on (tenant_id, x_id) so a row can never name
-- another carrier's driver, load or member (the insert fails with 23503), ENABLE and FORCE
-- row-level security and the one tenant_isolation policy on each new table. Additive only: no
-- proposal kind, no ledger kind, no money_actions change.

-- Eligible to receive money, separate from the card. Default false: a new driver is paid nothing
-- until a person arms them. Who and when live on the append-only log below.
ALTER TABLE drivers
  ADD COLUMN money_armed boolean NOT NULL DEFAULT false,
  ADD COLUMN money_armed_at timestamptz;

CREATE TABLE driver_arm_events (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id      uuid NOT NULL,
  armed          boolean NOT NULL,
  note           text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 240),
  -- Null for the seed; a person's change names the member who made it.
  membership_id  uuid,
  source         text NOT NULL CHECK (source IN ('seed', 'ui')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_arm_events_member_source CHECK ((source = 'ui') = (membership_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX driver_arm_events_driver ON driver_arm_events (tenant_id, driver_id, created_at);
ALTER TABLE driver_arm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_arm_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_arm_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE only because the seed's replace mode clears tenant tables as the app role; never UPDATE,
-- so a recorded change cannot be rewritten.
GRANT SELECT, INSERT, DELETE ON driver_arm_events TO payday_app;

-- The identity map: the id another system knows this driver by. Fuel cards stay in driver_cards.
CREATE TABLE driver_identities (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id    uuid NOT NULL,
  system       text NOT NULL CHECK (system IN ('tms')),
  external_id  text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9._-]{1,40}$'),
  source       text NOT NULL CHECK (source IN ('seed', 'ui', 'recon')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, system, external_id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX driver_identities_driver ON driver_identities (tenant_id, driver_id);
ALTER TABLE driver_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_identities
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON driver_identities TO payday_app;

-- Several cards per driver, one default. portal_name is what the provider's portal shows; a
-- generic card carries a placeholder there, never a person's name. A closed card is never the
-- default, so closing the default leaves the driver with none until a person picks another.
ALTER TABLE driver_cards
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN holder_kind text NOT NULL DEFAULT 'named' CHECK (holder_kind IN ('named', 'generic')),
  ADD COLUMN portal_name text CHECK (portal_name IS NULL OR portal_name ~ '^[A-Z0-9 -]{2,40}$'),
  ADD CONSTRAINT driver_cards_generic_named CHECK (holder_kind = 'named' OR portal_name IS NOT NULL),
  ADD CONSTRAINT driver_cards_default_active CHECK (NOT is_default OR status = 'active');
-- Name confirmed with \d on a fresh database (Postgres' default column CHECK name from 0017).
ALTER TABLE driver_cards DROP CONSTRAINT driver_cards_source_check;
ALTER TABLE driver_cards ADD CONSTRAINT driver_cards_source_check
  CHECK (source IN ('seed', 'ui', 'recon'));
-- One active card per driver becomes one default active card per driver: a second default fails
-- with 23505, a second active card that is not the default does not.
DROP INDEX driver_cards_one_active;
CREATE UNIQUE INDEX driver_cards_one_default ON driver_cards (tenant_id, driver_id)
  WHERE status = 'active' AND is_default;
-- Every existing active card was its driver's only one, so it becomes the default.
UPDATE driver_cards SET is_default = true WHERE status = 'active';

-- The load an advance is for, and a take-back. taken_back never exceeds what was advanced (the
-- service also bounds it by what is still owed), and only a paid advance has an amount taken back
-- (one taken back before payout is cancelled with nothing taken). A deleted load only clears the
-- reference.
ALTER TABLE advances
  ADD COLUMN load_id uuid,
  ADD COLUMN taken_back_cents bigint NOT NULL DEFAULT 0 CHECK (taken_back_cents >= 0),
  ADD COLUMN taken_back_at timestamptz,
  ADD COLUMN taken_back_by_membership_id uuid,
  ADD COLUMN takeback_reason text CHECK (takeback_reason IS NULL OR takeback_reason ~ '^[a-z_]{2,40}$'),
  ADD CONSTRAINT advances_load_fk FOREIGN KEY (tenant_id, load_id)
    REFERENCES loads (tenant_id, id) ON DELETE SET NULL (load_id),
  ADD CONSTRAINT advances_taken_back_by_fk FOREIGN KEY (tenant_id, taken_back_by_membership_id)
    REFERENCES memberships (tenant_id, id),
  -- The seed's history names no member, so the time and the reason go together and a member is
  -- named only with them.
  ADD CONSTRAINT advances_takeback_pair CHECK (
    (taken_back_at IS NULL) = (takeback_reason IS NULL)
    AND (taken_back_by_membership_id IS NULL OR taken_back_at IS NOT NULL)
    AND (taken_back_at IS NULL OR taken_back_by_membership_id IS NOT NULL OR source = 'seed')),
  ADD CONSTRAINT advances_takeback_bound CHECK (taken_back_cents <= amount_cents + fee_cents),
  ADD CONSTRAINT advances_takeback_paid CHECK (taken_back_cents = 0 OR status = 'paid');
CREATE INDEX advances_tenant_load ON advances (tenant_id, load_id) WHERE load_id IS NOT NULL;

-- Per-load cap as a share of the driver's pay for that load. NULL means no per-load cap.
ALTER TABLE pay_configs
  ADD COLUMN advance_per_load_bps_of_pay integer
    CHECK (advance_per_load_bps_of_pay IS NULL OR advance_per_load_bps_of_pay BETWEEN 0 AND 10000);
