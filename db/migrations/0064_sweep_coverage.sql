-- How much of the week each pay sweep checked (design-agents-102 3.3). Additive only: one column
-- on a table that already has forced row level security and its tenant policy, so no policy
-- changes and no new table (the reset deletes these rows with their run, and demo_reset_clear()
-- is not re-created).
--
-- sweep_runs gains:
--   coverage  { v: 1, checks: { required, ran }, drivers: { total, checked }, pct, fanout?:
--             { planned, checked } }, written by the run's own code: the find phase writes it in
--             the update that moves the phase, the second opinion adds fanout when it compares.
--             Null for a run whose find phase ran before this column existed or with
--             flags.verification off; such a run keeps none.
--
-- Locks: the check is added NOT VALID, so this file reads no rows and commits at once. Adding a
-- column with no default takes a brief exclusive lock on its table and rewrites nothing, but a
-- CHECK written on the new column itself would still scan every row under that lock (Postgres
-- does not skip the scan because the new column is null everywhere; tried on Postgres 15, an
-- inline CHECK (c IS NOT NULL) on a new column of a table with rows fails as violated). A NOT
-- VALID check holds for every row written from then on. The next file the runner applies, in its
-- own transaction, is 0064_sweep_coverage_validate.sql: it checks the rows already there under a
-- lock that lets reads and writes go on (the same split as 0028 and 0050). The check is a table
-- constraint only so it can be NOT VALID, and keeps the name Postgres gives an inline check.
ALTER TABLE sweep_runs
  ADD COLUMN coverage jsonb,
  ADD CONSTRAINT sweep_runs_coverage_check
    CHECK (coverage IS NULL OR jsonb_typeof(coverage) = 'object') NOT VALID;

-- The app role's grants on this table are column-level; INSERT is table-wide already, so only the
-- column updated after the insert is granted. The existing column lists stay as they are.
GRANT UPDATE (coverage) ON sweep_runs TO payday_app;
