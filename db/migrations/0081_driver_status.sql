-- DRIVER STATUS (0081): who deactivated or reactivated a driver, when, and why. A driver's state
-- stays where it already is, drivers.active_to (0004): null is active, a date is the last day they
-- drive for the carrier. An admin's change (src/lib/drivers/status.ts) writes active_to, and on a
-- deactivation clears money_armed with one driver_arm_events row, in the same transaction under
-- the driver's row lock; this table is that change's own log.
--
-- 1. driver_status_events: one row per change, always a person's (membership_id NOT NULL; the
--    seed never writes here). active false is a deactivation, true a reactivation; effective_on
--    is the active_to written (deactivate) or the one cleared (reactivate). note is optional,
--    1 to 240 characters, like the arming log's. Every reference carries tenant_id.
-- 2. Append-only for the app, as driver_arm_events (0027): SELECT and INSERT, no UPDATE and no
--    DELETE, so a recorded change can be neither rewritten nor removed. A row goes with its
--    driver through the cascade, which is how the seed's replace and the demo reset clear it.
--
-- A new, empty table: no existing row is changed or dropped, and no check is added to a table
-- that already has rows, so there is nothing to validate after this file.

CREATE TABLE driver_status_events (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id      uuid NOT NULL,
  -- true: reactivated; false: deactivated.
  active         boolean NOT NULL,
  -- The active_to written (deactivate) or cleared (reactivate).
  effective_on   date NOT NULL,
  note           text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 240),
  -- Always a person: the seed never writes here.
  membership_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id)     REFERENCES drivers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX driver_status_events_driver ON driver_status_events (tenant_id, driver_id, created_at);
ALTER TABLE driver_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_status_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- Append-only for the app: no UPDATE and no DELETE.
GRANT SELECT, INSERT ON driver_status_events TO payday_app;
