-- Validates the check 0088_mock_tms.sql re-created NOT VALID, against the rows already there. The
-- runner applies this file right after that one, in its own transaction, so 0088's locks are gone
-- by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads and writes go
-- on. Every value the new check allows is one the old check allowed, plus 'mock', so no row
-- already there can break it.
ALTER TABLE tms_connections VALIDATE CONSTRAINT tms_connections_system_check;
