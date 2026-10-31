-- Validates the two checks 0070_autopilot.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0070's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on. Every proposal already there has a null decision, and every source the new
-- desk_log check lists is one the check it replaced listed, plus autopilot, so no row can break
-- either.
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_autopilot_decision_check;
ALTER TABLE desk_log VALIDATE CONSTRAINT desk_log_source_check;
