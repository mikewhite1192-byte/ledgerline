-- ACTIVATION STEPS (0085): the three things a named admin did before a driver was armed to receive
-- money: identity confirmed against the card on file, a zero-dollar test sent to that card, and the
-- card's statement checked for loads nobody recorded. One row per driver, card and step; the arm
-- (src/lib/advances/arming.ts) refuses while any is missing for the driver's default card. The arm
-- log (0027) is untouched: a step is not an arm change.
--
-- 1. driver_cards_tenant_driver_id: a unique index on (tenant_id, driver_id, id), so a step names
--    its driver and its card together and can never cite another driver's card.
-- 2. driver_activation_steps: one row per step, always a person's (membership_id NOT NULL; the seed
--    never writes here). The dedupe key is (tenant_id, driver_id, card_id, step): a second click
--    writes nothing. note is optional, 1 to 240 characters, like the arming log's. Every reference
--    carries tenant_id.
-- 3. Append-only for the app, as driver_arm_events (0027) and driver_status_events (0081): SELECT
--    and INSERT, no UPDATE and no DELETE. A row goes with its driver or its card through the
--    cascade, which is how the seed's replace and the demo reset clear it.
--
-- A new, empty table and an index that cannot fail: no existing row is changed or dropped, and no
-- check is added to a table that already has rows, so there is nothing to validate after this file.

-- 1. Lets a step name its driver and its card together. Cannot fail: id is already the primary key.
CREATE UNIQUE INDEX driver_cards_tenant_driver_id ON driver_cards (tenant_id, driver_id, id);

-- 2. The steps.
CREATE TABLE driver_activation_steps (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id      uuid NOT NULL,
  card_id        uuid NOT NULL,
  step           text NOT NULL,
  note           text,
  -- Always a person: the seed never writes here.
  membership_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_activation_steps_step_check
    CHECK (step IN ('identity_confirmed', 'zero_test_sent', 'hand_load_acknowledged')),
  CONSTRAINT driver_activation_steps_note_check
    CHECK (note IS NULL OR length(note) BETWEEN 1 AND 240),
  CONSTRAINT driver_activation_steps_tenant_id_key UNIQUE (tenant_id, id),
  -- The dedupe key: one row per driver, card and step; a second click changes nothing.
  CONSTRAINT driver_activation_steps_one_per_card_step UNIQUE (tenant_id, driver_id, card_id, step),
  CONSTRAINT driver_activation_steps_driver_fk FOREIGN KEY (tenant_id, driver_id)
    REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT driver_activation_steps_card_fk FOREIGN KEY (tenant_id, driver_id, card_id)
    REFERENCES driver_cards (tenant_id, driver_id, id) ON DELETE CASCADE,
  CONSTRAINT driver_activation_steps_member_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships (tenant_id, id)
);
CREATE INDEX driver_activation_steps_driver ON driver_activation_steps (tenant_id, driver_id, created_at);
ALTER TABLE driver_activation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_activation_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_activation_steps
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- 3. Append-only for the app: no UPDATE and no DELETE. A row goes with its driver or its card.
GRANT SELECT, INSERT ON driver_activation_steps TO payday_app;
