-- Validates the check 0074_autopilot_money.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0074's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on. Every rule already there is a bookkeeping kind, and the money rules 0074 wrote
-- carry their driver's day, so no row can break it.
ALTER TABLE autopilot_rules VALIDATE CONSTRAINT autopilot_rules_driver_day_required;
