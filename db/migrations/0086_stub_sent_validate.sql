-- Validates the constraints 0086_stub_sent.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0086's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on (the foreign key's scan also takes ROW SHARE on memberships). Every row already
-- there has stub_sent_at and stub_sent_by null, so no row can break any of them.
ALTER TABLE settlements VALIDATE CONSTRAINT settlements_stub_sent_by_fk;
ALTER TABLE settlements VALIDATE CONSTRAINT settlements_stub_sent_pair;
ALTER TABLE settlements VALIDATE CONSTRAINT settlements_stub_sent_paid;
