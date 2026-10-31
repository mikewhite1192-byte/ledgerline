-- AUTOPILOT MONEY (0074): the owner's rule may let the autopilot approve the two kinds that pay a
-- driver (advance_payout and money_code), inside a limit for one driver's local day as well as the
-- carrier's. The policy still decides in code (src/lib/autopilot/policy.ts), and a money kind is
-- approved by nobody until its own armed is on in flags.autopilot.kinds, each in its own release.
--
-- 1. autopilot_rules.driver_day_max_cents: null, or a whole number of cents with one item's limit
--    at or under it and it at or under the carrier's day (autopilot_rules_driver_day_check). A rule
--    for advance_payout or money_code must carry one (autopilot_rules_driver_day_required). Both
--    checks are added NOT VALID and validated by the next file. The app role may change it.
-- 2. autopilot_rules_guard() re-created: a change to driver_day_max_cents moves the version up by
--    exactly one, like a change to the mode or the other limits. The trigger is unchanged.
-- 3. A rule for either kind that a carrier already set (0070 allows both) gets the tightest driver's
--    day that fits, one item's limit, and its version moves up by one through the guard.
-- 4. The starting rules for the two invented demo carriers: Auto on advance_payout and money_code
--    with their limits (the same values as src/lib/autopilot/defaults.ts). A carrier that already
--    has a rule for either kind keeps it (with the limit step 3 gave it).
--
-- No kind check changes anywhere, proposals_autopilot_guard and its decision check are unchanged
-- (the record only gains the driver it read), and no existing row is dropped; step 3 only narrows.

-- 1. The driver's day.
ALTER TABLE autopilot_rules ADD COLUMN driver_day_max_cents bigint;
ALTER TABLE autopilot_rules
  ADD CONSTRAINT autopilot_rules_driver_day_check CHECK (
    driver_day_max_cents IS NULL
    OR (driver_day_max_cents >= 0 AND driver_day_max_cents < 1000000000
        AND max_cents <= driver_day_max_cents AND driver_day_max_cents <= day_max_cents)) NOT VALID;
ALTER TABLE autopilot_rules
  ADD CONSTRAINT autopilot_rules_driver_day_required CHECK (
    kind NOT IN ('advance_payout', 'money_code') OR driver_day_max_cents IS NOT NULL) NOT VALID;
GRANT UPDATE (driver_day_max_cents) ON autopilot_rules TO payday_app;

-- 2. Invoker rights, owned by the migrating admin. A new rule starts at version 1; a change to its
-- mode or limits moves the version up by exactly one, and the version never moves on its own. The
-- raise rolls the transaction back.
CREATE OR REPLACE FUNCTION autopilot_rules_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'autopilot_rules: a new rule starts at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.max_cents IS DISTINCT FROM OLD.max_cents
     OR NEW.day_max_cents IS DISTINCT FROM OLD.day_max_cents
     OR NEW.day_max_count IS DISTINCT FROM OLD.day_max_count
     OR NEW.driver_day_max_cents IS DISTINCT FROM OLD.driver_day_max_cents THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'autopilot_rules: a changed rule moves its version up by one' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'autopilot_rules: the version moves only with a change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 3. Money rules set before this file: one item's limit is the driver's day, the narrowest that fits.
UPDATE autopilot_rules
   SET driver_day_max_cents = max_cents, version = version + 1, updated_by = 'setup', updated_at = now()
 WHERE kind IN ('advance_payout', 'money_code') AND driver_day_max_cents IS NULL;

-- 4. The starting money rules for the two invented demo carriers.
INSERT INTO autopilot_rules
  (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, updated_by)
SELECT t.id, d.kind, 'auto', d.max_cents, d.day_max_cents, d.day_max_count, d.driver_day_max_cents, 'setup'
  FROM tenants t
 CROSS JOIN (VALUES ('advance_payout', 30000, 150000, 10, 30000),
                    ('money_code', 15000, 60000, 4, 30000))
       AS d (kind, max_cents, day_max_cents, day_max_count, driver_day_max_cents)
 WHERE t.slug IN ('blue-ridge', 'prairie-wind')
ON CONFLICT (tenant_id, kind) DO NOTHING;
