-- Validates the check 0063_approved_edits.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0063's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the table,
-- which lets reads and writes go on. Every existing row holds a null approved_edits, which the
-- check allows.
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_approved_edits_check;
