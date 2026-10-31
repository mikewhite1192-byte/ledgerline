-- Validates the two checks 0074_autopilot_money.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0074's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on. 0074 gave every money rule already there one item's limit as its driver's day,
-- and the money rules it wrote carry theirs, so no row can break either check.
ALTER TABLE autopilot_rules VALIDATE CONSTRAINT autopilot_rules_driver_day_check;
ALTER TABLE autopilot_rules VALIDATE CONSTRAINT autopilot_rules_driver_day_required;
