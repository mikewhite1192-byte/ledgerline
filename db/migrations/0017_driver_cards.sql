-- The driver's fuel card on file: the provider's own reference for the card and the last four
-- digits, never a card number or an expiry. Same conventions as 0004 to 0006: the tenant on every
-- row, a composite foreign key to the driver so a card can never name another carrier's driver
-- (the insert fails with 23503), ENABLE and FORCE row-level security, and the one tenant_isolation
-- policy. sim_behavior exists only because the provider is simulated: it is what the simulated
-- provider answers for this card; a real adapter ignores it.
CREATE TABLE driver_cards (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL,
  rail            text NOT NULL DEFAULT 'fuel_card' CHECK (rail = 'fuel_card'),
  provider        text NOT NULL CHECK (provider IN ('fuel_card_sim')),
  provider_token  text NOT NULL CHECK (provider_token ~ '^fcs_card_[0-9a-f]{24}$'),
  last4           text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  status          text NOT NULL CHECK (status IN ('active', 'closed')),
  sim_behavior    text NOT NULL DEFAULT 'ok' CHECK (sim_behavior IN ('ok', 'declined', 'slow', 'offline')),
  source          text NOT NULL CHECK (source IN ('seed', 'ui')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_token),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE
);

-- One active card per driver: a second one fails with 23505 until the first is closed.
CREATE UNIQUE INDEX driver_cards_one_active ON driver_cards (tenant_id, driver_id)
  WHERE status = 'active';

ALTER TABLE driver_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_cards
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE because the seed's replace mode clears tenant tables as the app role (as drivers).
GRANT SELECT, INSERT, UPDATE, DELETE ON driver_cards TO payday_app;

-- The card an advance's latest payout attempt went to. Null for seeded history and for an
-- advance not yet paid. Deleting the card only clears the reference.
ALTER TABLE advances ADD COLUMN card_id uuid;
ALTER TABLE advances ADD CONSTRAINT advances_card_fk
  FOREIGN KEY (tenant_id, card_id) REFERENCES driver_cards (tenant_id, id) ON DELETE SET NULL (card_id);

-- The simulated fuel-card provider is a fourth outside system, and a card decline is a definite
-- failure. Both CHECKs are re-created with their full lists (names confirmed with \d on a fresh
-- database: Postgres' default column CHECK names from 0006). A later migration that re-creates
-- either one must carry these lists whole.
ALTER TABLE money_actions DROP CONSTRAINT money_actions_outside_system_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_outside_system_check
  CHECK (outside_system IN ('mock', 'stripe_test', 'qbo_sandbox', 'fuel_card_sim'));
ALTER TABLE money_actions DROP CONSTRAINT money_actions_failure_category_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_failure_category_check
  CHECK (failure_category IN ('disabled', 'not_connected', 'not_configured', 'validation', 'duplicate',
    'auth', 'rate_limited', 'unavailable', 'timeout', 'network', 'amount_mismatch', 'outside_failed',
    'declined', 'unknown'));
