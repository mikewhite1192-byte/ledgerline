-- Validates the checks 0092_books.sql re-created NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0092's locks
-- are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads and
-- writes go on. Each re-created check allows everything the one it replaced allowed, so no row
-- already there can break any of them.
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_kind_check;
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_money_code_subject_pairing;
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_escrow_subject_pairing;
