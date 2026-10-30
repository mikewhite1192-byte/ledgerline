-- The person's own values on a pay_policy_setup card, stored with the approval. The approve
-- request validates its edits before the approval, but the version is written after it, in the
-- executor's own transaction; a resume runs the executor again. Without a stored copy a resume
-- would plan from whatever edits it sent, so the version written could differ from the one the
-- person approved. The gate now writes the exact edits it validated in the same statement that
-- moves the proposal to approved, and the executor plans only from this column.
--
-- proposals gains:
--   approved_edits  the rule key to stored value text map the approval carried ({} for none),
--                   written only by the approval of a pay_policy_setup card; null on every other
--                   kind and on a card not yet approved
--
-- Additive only: proposals already has forced row-level security and its tenant policy, and
-- demo_reset_clear() deletes its rows whole, so neither is re-created. The app role's UPDATE grant
-- on proposals is column-level, so the new column is granted next to the ones the approval
-- already writes. proposals_guard() is not re-created (0059 owns it); the new rule lives in its
-- own trigger function below.
--
-- Locks: the check is added NOT VALID, so this file reads no rows and commits at once. Adding a
-- nullable column with no default takes a brief exclusive lock on proposals and rewrites nothing.
-- A NOT VALID check holds for every row written from then on. The next file the runner applies,
-- in its own transaction, is 0063_approved_edits_validate.sql: it checks the rows already there
-- under a lock that lets reads and writes go on (the same split as 0050 and 0062).
ALTER TABLE proposals
  ADD COLUMN approved_edits jsonb,
  ADD CONSTRAINT proposals_approved_edits_check CHECK (
    (approved_edits IS NULL OR jsonb_typeof(approved_edits) = 'object')
    AND (status <> 'proposed' OR approved_edits IS NULL)) NOT VALID;

GRANT UPDATE (approved_edits) ON proposals TO payday_app;

-- Invoker rights, owned by the migrating admin. The approved edits are set once, in the update
-- that moves the proposal from proposed to approved, and never change after. The raise rolls the
-- transaction back.
CREATE FUNCTION proposals_approved_edits_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.approved_edits IS DISTINCT FROM OLD.approved_edits AND NOT (
       OLD.approved_edits IS NULL AND OLD.status = 'proposed' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'proposals: the approved edits are set only with the approval, once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER proposals_approved_edits_guard
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_approved_edits_guard();
