-- Validates the checks 0079_parked_advances.sql added or re-created NOT VALID, against the rows
-- that were already there. The runner applies this file right after that one, in its own
-- transaction, so 0079's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE
-- EXCLUSIVE, which lets reads and writes go on. Every status the new status check lists is one the
-- check it replaced listed, plus parked, and both new columns are null on every row already there,
-- so no row already there can break any of the five.
ALTER TABLE advances VALIDATE CONSTRAINT advances_park_reason_check;
ALTER TABLE advances VALIDATE CONSTRAINT advances_status_check;
ALTER TABLE advances VALIDATE CONSTRAINT advances_parked_pair;
ALTER TABLE advances VALIDATE CONSTRAINT advances_parked_reason;
ALTER TABLE advances VALIDATE CONSTRAINT advances_parked_flow;
