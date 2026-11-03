-- Validates the check 0083_tms_wakeups.sql re-created NOT VALID, against the rows already there.
-- The runner applies this file right after that one, in its own transaction, so 0083's locks are
-- gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads and writes
-- go on. Every value the new check allows is one the old check allowed, plus 'webhook', so no row
-- already there can break it.
ALTER TABLE desk_log VALIDATE CONSTRAINT desk_log_by_check;
