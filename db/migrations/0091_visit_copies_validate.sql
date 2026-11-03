-- Validates the checks 0091_visit_copies.sql added NOT VALID, against the rows that were already
-- there. The runner applies this file right after that one, in its own transaction, so 0091's locks
-- are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads and
-- writes go on. The checked columns are new and null on every row already there, so none can break.
ALTER TABLE demo_sessions VALIDATE CONSTRAINT demo_sessions_copy_pair;
ALTER TABLE demo_sessions VALIDATE CONSTRAINT demo_sessions_copy_ready;
ALTER TABLE tenants VALIDATE CONSTRAINT tenants_demo_copy_of_shape;
