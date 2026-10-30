-- Runs that stop cleanly at their turn ceiling, and portal runs that carry on after a stop.
-- Additive only: two counters on tables that already have forced row level security and their
-- tenant policy, so no policy changes and no new table (the reset deletes these rows with their
-- run, and demo_reset_clear() is not re-created).
--
-- portal_runs gains:
--   resume_attempts  how many times a run that stalled while running (its worker stopped
--                    mid-run) was put back in the queue to carry on from its last executed step;
--                    at 2 a stalled run is failed as a runner error, as before
-- sweep_runs gains:
--   turns_used       the findings this run has taken to draft, counted as each is taken, so the
--                    draft step stops at the run's turn ceiling (flags.runLimits.maxTurns) and
--                    leaves the rest found for the next run
ALTER TABLE portal_runs
  ADD COLUMN resume_attempts smallint NOT NULL DEFAULT 0 CHECK (resume_attempts BETWEEN 0 AND 2);

ALTER TABLE sweep_runs
  ADD COLUMN turns_used smallint NOT NULL DEFAULT 0 CHECK (turns_used BETWEEN 0 AND 1000);

-- The app role's grants on these tables are column-level; INSERT is table-wide already, so only
-- the columns updated after the insert are granted. The existing column lists stay as they are.
GRANT UPDATE (resume_attempts) ON portal_runs TO payday_app;
GRANT UPDATE (turns_used) ON sweep_runs TO payday_app;
