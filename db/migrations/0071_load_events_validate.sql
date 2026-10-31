-- Validates the two checks 0071_load_events.sql re-created NOT VALID, against the rows that were
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0071's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets
-- reads and writes go on. Every kind and every source the new checks list is one the checks they
-- replaced listed, plus load_move, document and load_event, so no row already there can break them.
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_kind_check;
ALTER TABLE desk_log VALIDATE CONSTRAINT desk_log_source_check;
