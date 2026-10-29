-- The agent's checklist: the short plan a chat answer or a run sets first and ticks as it goes,
-- shown live above the steps. Additive only: new columns on tables that already have forced row
-- level security and their tenant policy, so no policy changes and no new table (the reset
-- deletes these rows with their turn or run, and demo_reset_clear() is not re-created).
--
-- turns gains:
--   checklist        { v: 1, by: "model" | "run", items: [{ key, text, state }] }, 1 to 12 items,
--                    checked in code (zod) before every write; null when the answer set none
--   context_summary  the state summary the turn started from, whole, for the step-through
-- turn_steps gains:
--   reasoning_note   the model's own short note for a model step, when one came back, with
--                    figures masked like an answer
-- sweep_runs and portal_runs gain checklist, the same shape, written by the run's own code.
ALTER TABLE turns
  ADD COLUMN checklist jsonb CHECK (
    checklist IS NULL OR (
      CASE WHEN jsonb_typeof(checklist) = 'object' AND jsonb_typeof(checklist -> 'items') = 'array'
           THEN jsonb_array_length(checklist -> 'items') BETWEEN 1 AND 12
                AND length(checklist::text) <= 4000
           ELSE false END
    )
  ),
  ADD COLUMN context_summary text CHECK (context_summary IS NULL OR length(context_summary) <= 10000);

ALTER TABLE turn_steps
  ADD COLUMN reasoning_note text CHECK (reasoning_note IS NULL OR length(reasoning_note) <= 2000);

ALTER TABLE sweep_runs
  ADD COLUMN checklist jsonb CHECK (
    checklist IS NULL OR (
      CASE WHEN jsonb_typeof(checklist) = 'object' AND jsonb_typeof(checklist -> 'items') = 'array'
           THEN jsonb_array_length(checklist -> 'items') BETWEEN 1 AND 12
                AND length(checklist::text) <= 4000
           ELSE false END
    )
  );

ALTER TABLE portal_runs
  ADD COLUMN checklist jsonb CHECK (
    checklist IS NULL OR (
      CASE WHEN jsonb_typeof(checklist) = 'object' AND jsonb_typeof(checklist -> 'items') = 'array'
           THEN jsonb_array_length(checklist -> 'items') BETWEEN 1 AND 12
                AND length(checklist::text) <= 4000
           ELSE false END
    )
  );

-- The app role's grants on these tables are column-level; INSERT is table-wide already, so only
-- the columns updated after the insert are granted. The existing column lists stay as they are.
GRANT UPDATE (checklist) ON turns TO payday_app;
GRANT UPDATE (reasoning_note) ON turn_steps TO payday_app;
GRANT UPDATE (checklist) ON sweep_runs TO payday_app;
GRANT UPDATE (checklist) ON portal_runs TO payday_app;
