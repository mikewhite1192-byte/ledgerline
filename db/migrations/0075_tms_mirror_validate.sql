-- Validates the four checks 0075_tms_mirror.sql re-created NOT VALID, against the rows already
-- there. The runner applies this file right after that one, in its own transaction, so 0075's
-- locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads
-- and writes go on. Every value the new checks allow is one the checks they replaced allowed,
-- plus 'tms', 'tms_status_events' and 'tms_event', so no row already there can break them.
ALTER TABLE load_events VALIDATE CONSTRAINT load_events_source_check;
ALTER TABLE load_events VALIDATE CONSTRAINT load_events_evidence_table_check;
ALTER TABLE load_events VALIDATE CONSTRAINT load_events_evidence_source;
ALTER TABLE desk_log VALIDATE CONSTRAINT desk_log_source_check;
