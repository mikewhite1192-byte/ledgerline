-- The notes the second check saw are fixed with its verdict (CARRIER-MEMORY part 2). 0040 added
-- proposals.auditor_notes_used and granted payday_app UPDATE on it, and the app writes it only in
-- the statement that writes the verdict (writeAuditVerdict, src/lib/agent/gateway/store/audit.ts),
-- but the guard from 0014 does not list it, so the table would let it change after the verdict.
--
-- proposals_guard() re-created whole from its latest definition (0014), unchanged except for one
-- added rule: auditor_notes_used never changes once auditor_checked_at is set (0014's check ties
-- checked_at to the verdict, so this is the moment the verdict lands). Every rule 0014 has stays,
-- word for word, with the same messages and the same error code. The trigger (0009) is not
-- touched; it calls this function by name. No other migration re-creates this function, so it runs
-- the same in number order and in production's order, where it lands after 0040. Any later
-- migration that re-creates this function carries every rule here.
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
  IF OLD.auditor_checked_at IS NOT NULL
     AND NEW.auditor_notes_used IS DISTINCT FROM OLD.auditor_notes_used THEN
    RAISE EXCEPTION 'proposals: the notes an audit saw never change once set'
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
