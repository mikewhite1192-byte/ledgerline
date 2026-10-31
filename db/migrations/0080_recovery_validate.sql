-- Validates the checks 0080_recovery.sql added or re-created NOT VALID, against the rows that were
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0080's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets
-- reads and writes go on. Each re-created list is the list it replaced plus the new values, and
-- every stored deficit has recovered_cents 0 and settled_in null, so no row already there can break
-- any of them.
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_kind_check;
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_subject_table_check;
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_channel_pairing;
ALTER TABLE money_actions VALIDATE CONSTRAINT money_actions_pullback_subject_pairing;
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_kind_check;
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_subject_table_check;
ALTER TABLE driver_deficits VALIDATE CONSTRAINT driver_deficits_recovered_within;
ALTER TABLE driver_deficits VALIDATE CONSTRAINT driver_deficits_settled_whole;
ALTER TABLE settlement_lines VALIDATE CONSTRAINT settlement_lines_kind_check;
ALTER TABLE load_events VALIDATE CONSTRAINT load_events_to_status_check;
ALTER TABLE load_events VALIDATE CONSTRAINT load_events_one_step;
