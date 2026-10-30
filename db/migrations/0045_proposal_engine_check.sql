-- Unverified to Verified (AGENTS-101 part 6): the rules engine's own recompute of a proposal,
-- compared in code to the cent and stored on the proposal whether or not the second check runs,
-- and a person's reason when they approve over a mismatch. Additive only: new columns on
-- proposals, which already has forced row level security and its tenant policy, so no policy
-- changes and no new table (the reset deletes proposals already, so these go with their rows, and
-- demo_reset_clear() is not re-created).
--
-- proposals gains:
--   engine_check       matched | mismatch | unavailable; null until the comparison ran. A cut or
--                      refused engine result, or a kind with no comparison, is unavailable, never
--                      matched; a read error stores nothing, so a later pass tries again.
--   engine_cents       the engine's own amount in integer cents, when it gave one
--   engine_checked_at  when the comparison was stored; set with engine_check, never alone
--   engine_override_reason, engine_override_by, engine_override_at
--                      a person's reason for approving over a mismatch, who, and when. 0014's
--                      override columns stay for a block only (proposals_auditor_override_only_block),
--                      so a mismatch's reason has its own, with the same length rules.
--
-- The rules are a second trigger function on the same table, not a re-created proposals_guard():
-- 0059 re-creates proposals_guard() and sorts after this file, so on a fresh database (name order)
-- it would replace any rule added here, while production (merge order) applies 0059 first. A
-- function of its own runs the same in both orders, and a later re-creation of proposals_guard()
-- need not carry these rules. proposals_guard() itself is not touched. Invoker rights, owned by
-- the migrating admin, the same messages style and error code as the guard:
--   * an engine check, its cents and its time never change once set, and are set only while the
--     proposal is waiting (never in the statement that decides it, never after);
--   * an engine override never changes once set, and is set only in the same statement that moves
--     the proposal from proposed to approved (the approve gate, src/lib/proposals/execute.ts), so a
--     stored reason always sits on an approved or later proposal and refers to the stored mismatch.
ALTER TABLE proposals
  ADD COLUMN engine_check text CHECK (engine_check IN ('matched', 'mismatch', 'unavailable')),
  ADD COLUMN engine_cents bigint CHECK (engine_cents >= 0 AND engine_cents < 1000000000),
  ADD COLUMN engine_checked_at timestamptz,
  -- A person's override of a mismatch: their words, who, when. Never read by a model.
  ADD COLUMN engine_override_reason text CHECK (length(engine_override_reason) BETWEEN 10 AND 240),
  ADD COLUMN engine_override_by     text CHECK (length(engine_override_by) BETWEEN 1 AND 128),
  ADD COLUMN engine_override_at     timestamptz,
  ADD CONSTRAINT proposals_engine_check_whole CHECK ((engine_check IS NULL) = (engine_checked_at IS NULL)),
  ADD CONSTRAINT proposals_engine_cents_with_check CHECK (engine_cents IS NULL OR engine_check IS NOT NULL),
  ADD CONSTRAINT proposals_engine_override_whole CHECK (
    (engine_override_reason IS NULL AND engine_override_by IS NULL AND engine_override_at IS NULL)
    OR (engine_override_reason IS NOT NULL AND engine_override_by IS NOT NULL
        AND engine_override_at IS NOT NULL)),
  ADD CONSTRAINT proposals_engine_override_only_mismatch CHECK (
    engine_override_reason IS NULL OR engine_check = 'mismatch');

CREATE FUNCTION proposals_engine_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.engine_check IS NOT NULL AND (
       NEW.engine_check IS DISTINCT FROM OLD.engine_check
    OR NEW.engine_cents IS DISTINCT FROM OLD.engine_cents
    OR NEW.engine_checked_at IS DISTINCT FROM OLD.engine_checked_at) THEN
    RAISE EXCEPTION 'proposals: an engine check never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.engine_check IS NULL AND NEW.engine_check IS NOT NULL
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'proposed') THEN
    RAISE EXCEPTION 'proposals: an engine check is set only while the proposal waits'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.engine_override_reason IS NOT NULL AND (
       NEW.engine_override_reason IS DISTINCT FROM OLD.engine_override_reason
    OR NEW.engine_override_by IS DISTINCT FROM OLD.engine_override_by
    OR NEW.engine_override_at IS DISTINCT FROM OLD.engine_override_at) THEN
    RAISE EXCEPTION 'proposals: an engine override never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.engine_override_reason IS NULL AND NEW.engine_override_reason IS NOT NULL
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'proposals: an engine override is set only with the approval'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER proposals_engine_guard
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_engine_guard();

-- The app role's grants on proposals are column-level; INSERT is table-wide already, so only the
-- columns updated after the insert are granted. The existing column lists stay as they are.
GRANT UPDATE (engine_check, engine_cents, engine_checked_at,
              engine_override_reason, engine_override_by, engine_override_at) ON proposals TO payday_app;
