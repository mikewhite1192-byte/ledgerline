-- Validates the check 0069_escrow_releases.sql re-created NOT VALID, against the rows that were
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0069's lock is gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the table,
-- which lets reads and writes go on. Every kind the new check lists is one the check it replaced
-- listed, plus escrow_release, so no row already there can break it.
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_kind_check;
