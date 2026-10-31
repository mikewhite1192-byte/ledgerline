-- ADVANCE-AT-PICKUP (0073): when a load's pay first counts toward what a driver can draw early.
-- Additive only: one column on pay_configs, which already has forced row level security and its
-- tenant policy, so no policy changes, no new table, and demo_reset_clear() is not re-created.
--
-- pay_configs gains:
--   advance_unlock_stage  'delivered' (the default, and every carrier's rule until now): a load's
--                         pay counts once the load is delivered, as before. 'picked_up': the one
--                         load an advance is drawn against also counts from the moment its pickup
--                         is on record (its first load_events move to in_transit), so a driver can
--                         draw against the trip he is on. Every other cap still applies (the
--                         driver's limit, the share of earned pay, the per-load cap, the minimum,
--                         the duplicate window and the fee), and the rules engine computes every
--                         number (src/lib/rules-engine/advances.ts). Nothing here moves money.
--
-- The pay rules version copy (src/lib/pay-rules/write-version.ts) reads pay_configs' columns from
-- the catalog, so a new version carries this column as the old one had it.
--
-- Locks: the check is added NOT VALID, so this file reads no rows and commits at once. Adding a
-- column with a constant default takes a brief exclusive lock on its table and rewrites nothing.
-- A NOT VALID check holds for every row written from then on. The next file the runner applies,
-- in its own transaction, is 0073_advance_unlock_stage_validate.sql: it checks the rows already
-- there under a lock that lets reads and writes go on (the same split as 0050). The check is a
-- table constraint only so it can be NOT VALID, and it keeps the name Postgres gives an inline
-- check.
ALTER TABLE pay_configs
  ADD COLUMN advance_unlock_stage text NOT NULL DEFAULT 'delivered',
  ADD CONSTRAINT pay_configs_advance_unlock_stage_check
    CHECK (advance_unlock_stage IN ('delivered', 'picked_up')) NOT VALID;
