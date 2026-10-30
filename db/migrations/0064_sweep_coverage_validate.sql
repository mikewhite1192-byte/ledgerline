-- Validates the check 0064_sweep_coverage.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0064's
-- lock is gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the table, which
-- lets reads and writes go on. Every existing row holds null in the new column, which the check
-- allows.
ALTER TABLE sweep_runs VALIDATE CONSTRAINT sweep_runs_coverage_check;
