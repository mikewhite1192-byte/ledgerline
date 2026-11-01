-- Validates the four checks 0082_morning_digest.sql added or re-created NOT VALID, against the rows
-- already there. The runner applies this file right after that one, in its own transaction, so
-- 0082's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets
-- reads and writes go on. Every source and kind the new lists hold is one the lists they replaced
-- held, plus digest; every row already there is an ask or a told line with a proposal (0072 made
-- proposal_id NOT NULL) and a null period_date (the column is new); and the done rule only widens.
-- So no row already there can break any of the four.
ALTER TABLE desk_log VALIDATE CONSTRAINT desk_log_source_check;
ALTER TABLE agent_asks VALIDATE CONSTRAINT agent_asks_kind_check;
ALTER TABLE agent_asks VALIDATE CONSTRAINT agent_asks_digest_shape;
ALTER TABLE agent_asks VALIDATE CONSTRAINT agent_asks_check3;
