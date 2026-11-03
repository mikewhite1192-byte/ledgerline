-- Validates the constraints 0084_named_lines.sql added NOT VALID, against the rows that were
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0084's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets
-- reads and writes go on (a foreign key's scan also takes ROW SHARE on memberships). Every row
-- already there has entered_by and source_ref null, so no row can break any of them.
ALTER TABLE pay_items VALIDATE CONSTRAINT pay_items_entered_by_fk;
ALTER TABLE pay_items VALIDATE CONSTRAINT pay_items_named_has_ref;
ALTER TABLE settlement_lines VALIDATE CONSTRAINT settlement_lines_entered_by_fk;
ALTER TABLE settlement_lines VALIDATE CONSTRAINT settlement_lines_source_ref_form;
ALTER TABLE settlement_lines VALIDATE CONSTRAINT settlement_lines_named_pair;
