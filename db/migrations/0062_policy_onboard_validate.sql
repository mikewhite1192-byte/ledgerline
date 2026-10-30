-- Validates the two checks 0062_policy_onboard.sql re-created NOT VALID, against the rows that
-- were already there. The runner applies this file right after that one, in its own transaction,
-- so 0062's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the
-- table, which lets reads and writes go on. One constraint per statement, so a failure names the
-- statement that broke. Every kind each new check lists is one the check it replaced listed, plus
-- one new kind, so no row already there can break it.
ALTER TABLE documents VALIDATE CONSTRAINT documents_document_kind_check;
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_kind_check;
