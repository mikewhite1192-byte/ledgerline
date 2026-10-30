-- Validates the two checks 0050_portal_resume_attempts.sql added NOT VALID, against the rows that
-- were already there. The runner applies this file right after that one, in its own transaction,
-- so 0050's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the
-- table, which lets reads and writes go on. One constraint per statement, so a failure names the
-- statement that broke. Every existing row holds the column default 0, which both checks allow.
ALTER TABLE portal_runs VALIDATE CONSTRAINT portal_runs_resume_attempts_check;
ALTER TABLE sweep_runs VALIDATE CONSTRAINT sweep_runs_turns_used_check;
