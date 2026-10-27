-- The auditor's record on a proposal. auditor_verdict, auditor_call_id and auditor_agrees exist
-- from 0009. concerns are fixed categories; started_at is a 90-second lease so two page loads
-- make one model call; attempts counts the leases taken, so a check that keeps failing stops
-- asking the model; checked_at is when the verdict landed; trace_id ties the audit's model
-- call and its gateway decision together.
-- Verdicts are pass / concerns / block / unknown. 0009 had agree / disagree / unknown; the check
-- is replaced here, before any audited row exists in production. 0009 declared it inline, so
-- Postgres named it proposals_auditor_verdict_check.
ALTER TABLE proposals DROP CONSTRAINT proposals_auditor_verdict_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_auditor_verdict_check
  CHECK (auditor_verdict IN ('pass', 'concerns', 'block', 'unknown'));

ALTER TABLE proposals
  ADD COLUMN auditor_concerns        jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(auditor_concerns) = 'array'),
  ADD COLUMN auditor_started_at      timestamptz,
  ADD COLUMN auditor_attempts        smallint NOT NULL DEFAULT 0 CHECK (auditor_attempts >= 0),
  ADD COLUMN auditor_checked_at      timestamptz,
  ADD COLUMN auditor_trace_id        uuid,
  -- A person's override of a block: their words, who, when. Never read by a model.
  ADD COLUMN auditor_override_reason text CHECK (length(auditor_override_reason) BETWEEN 10 AND 240),
  ADD COLUMN auditor_override_by     text CHECK (length(auditor_override_by) BETWEEN 1 AND 128),
  ADD COLUMN auditor_override_at     timestamptz,
  -- 0009's agree/disagree mapped onto the new words: pass agrees, concerns and block disagree,
  -- unknown says nothing.
  ADD CONSTRAINT proposals_auditor_agrees_matches CHECK (
    (auditor_verdict IS NULL AND auditor_agrees IS NULL)
    OR (auditor_verdict = 'pass' AND auditor_agrees IS TRUE)
    OR (auditor_verdict IN ('concerns', 'block') AND auditor_agrees IS FALSE)
    OR (auditor_verdict = 'unknown' AND auditor_agrees IS NULL)),
  ADD CONSTRAINT proposals_auditor_checked CHECK (
    (auditor_verdict IS NULL) = (auditor_checked_at IS NULL)),
  ADD CONSTRAINT proposals_auditor_override_whole CHECK (
    (auditor_override_reason IS NULL AND auditor_override_by IS NULL AND auditor_override_at IS NULL)
    OR (auditor_override_reason IS NOT NULL AND auditor_override_by IS NOT NULL
        AND auditor_override_at IS NOT NULL)),
  ADD CONSTRAINT proposals_auditor_override_only_block CHECK (
    auditor_override_reason IS NULL OR auditor_verdict = 'block');

-- The guard from 0009, with the auditor's rules added:
--   * a verdict, its time and its model call never change once set, so a second audit cannot
--     overwrite the first;
--   * an override never changes once set, and is set only in the same statement that moves a
--     waiting proposal to approved (the approve gate writes both under the row lock, before the
--     kind's executor runs), so a stored override always sits on an approved or later proposal.
CREATE OR REPLACE FUNCTION proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.flagged_input_id IS NOT NULL
     AND NEW.flagged_input_id IS DISTINCT FROM OLD.flagged_input_id THEN
    RAISE EXCEPTION 'proposals: a flag never changes once set' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executing', 'failed'))
    OR (OLD.status = 'executing' AND NEW.status IN ('done', 'failed'))) THEN
    RAISE EXCEPTION 'proposals: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.money_action_id IS NOT NULL AND NEW.money_action_id IS NOT NULL
     AND NEW.money_action_id IS DISTINCT FROM OLD.money_action_id THEN
    RAISE EXCEPTION 'proposals: the money action never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auditor_verdict IS NOT NULL AND (
       NEW.auditor_verdict IS DISTINCT FROM OLD.auditor_verdict
    OR NEW.auditor_agrees IS DISTINCT FROM OLD.auditor_agrees
    OR NEW.auditor_checked_at IS DISTINCT FROM OLD.auditor_checked_at
    OR NEW.auditor_concerns IS DISTINCT FROM OLD.auditor_concerns) THEN
    RAISE EXCEPTION 'proposals: an audit verdict never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auditor_call_id IS NOT NULL AND NEW.auditor_call_id IS DISTINCT FROM OLD.auditor_call_id THEN
    RAISE EXCEPTION 'proposals: the audit call never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auditor_override_reason IS NOT NULL AND (
       NEW.auditor_override_reason IS DISTINCT FROM OLD.auditor_override_reason
    OR NEW.auditor_override_by IS DISTINCT FROM OLD.auditor_override_by
    OR NEW.auditor_override_at IS DISTINCT FROM OLD.auditor_override_at) THEN
    RAISE EXCEPTION 'proposals: an override never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auditor_override_reason IS NULL AND NEW.auditor_override_reason IS NOT NULL
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'proposals: an override is set only with the approval'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

GRANT UPDATE (auditor_concerns, auditor_started_at, auditor_attempts, auditor_checked_at,
              auditor_trace_id, auditor_override_reason, auditor_override_by, auditor_override_at)
  ON proposals TO payday_app;

-- The proposals still waiting for an audit, per tenant, oldest first.
CREATE INDEX proposals_unaudited_idx ON proposals (tenant_id, created_at)
  WHERE status = 'proposed' AND auditor_verdict IS NULL;
