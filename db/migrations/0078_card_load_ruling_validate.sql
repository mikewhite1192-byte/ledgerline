-- Validates the kind check 0078_card_load_ruling.sql re-created NOT VALID, against the rows that
-- were already there. The runner applies this file right after that one, in its own transaction,
-- so 0078's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which
-- lets reads and writes go on. Every kind the new check lists is one the check it replaced listed,
-- plus card_load_ruling, so no row already there can break it.
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_kind_check;
