-- Validates the check 0077_never_alone.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0077's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on. 0077 narrowed every Auto rule on a kind off the allowlist to Ask me, and the
-- check refused any new one from then on, so no row can break autopilot_rules_auto_allowlist.
ALTER TABLE autopilot_rules VALIDATE CONSTRAINT autopilot_rules_auto_allowlist;
