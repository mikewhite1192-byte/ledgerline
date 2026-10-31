-- Validates the check 0073_advance_unlock_stage.sql added NOT VALID, against the rows that were
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0073's lock is gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE on the table,
-- which lets reads and writes go on. Every existing row holds the column default 'delivered',
-- which the check allows.
ALTER TABLE pay_configs VALIDATE CONSTRAINT pay_configs_advance_unlock_stage_check;
