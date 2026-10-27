-- The demo reset: one delete-capable function for the two synthetic demo carriers, so a carrier
-- admin can put the demo back to its seeded week from the app (/settings/demo), with no laptop.
--
-- This breaks the 0006 convention "never security definer" on purpose, and only here. The app logs
-- in as payday_app, which has no DELETE on the money ledger (money_actions) or on the agent's
-- records (documents, evidence_clips, the portal runner's tables, voice_notes, voice_note_audio,
-- driver_notes, turn_steps, proposals, turns, conversations): they are the record of what was paid
-- and what the agent did. Nor on the fictional broker portal's loads, which only the seed writes.
-- A reset needs exactly those rows gone for one demo carrier, and an app process holds no other
-- login, so this function runs as its owner (the migrating admin) and does that one job.
-- src/lib/db/rls-coverage.db.test.ts allows this function and no other security-definer function,
-- and checks every bound below.
--
-- What bounds it:
--   * search_path is fixed to public, then pg_temp, and every table and function it names is
--     schema-qualified, so nothing a caller creates can stand in for them (the app role has no
--     CREATE on public either, which the same test checks).
--   * EXECUTE is revoked from PUBLIC and granted to payday_app only.
--   * It acts on the calling transaction's tenant, current_tenant_id(), and on nothing else. Its
--     owner is not bound by row-level security, so every statement names that tenant itself.
--   * It refuses any tenant whose slug, name and timezone are not all one demo carrier's (the seed's
--     DEMO_CARRIERS in src/lib/seed/carriers.ts; src/lib/seed/reset.test.ts keeps the two in step),
--     so a real carrier can never be reset this way. The slug alone is not enough: payday_app may
--     update its own tenant row, so a carrier could take a slug a demo carrier gave up.
--   * It takes the tenant row lock first. Two resets of one carrier run one after the other, a
--     write already in flight for that carrier (every tenant table references tenants, and an
--     insert holds a key-share lock on its tenant row) lands before the counts are read, and no
--     new row for that carrier can be added until the reset's transaction ends.
--   * It refuses, deleting nothing, while the carrier has a ledger row still reserved, sent or
--     unknown (its outcome is not known yet), a row failed as amount_mismatch (money may have
--     moved for another amount), or a proposal flagged by an outside message that a ledger row
--     names. A person settles or reviews those first. The refusal carries counts only.
--   * The seed's fourth refusal (a ledger row naming an advance an approval created,
--     FLOW_ADVANCE_ROWS in src/lib/seed/run.ts) is left out on purpose: once the refusals pass,
--     every money_actions row of the carrier is settled, and this function deletes them all before
--     the advances, in one transaction, so no ledger row can be left naming a deleted advance.
--
-- It deletes, for that tenant only: the settled ledger rows (confirmed or failed, never
-- amount_mismatch), the uploaded documents, the dock clips (0023; each names a load the replace
-- deletes), the portal runner's evidence, checks, steps, sessions and runs (0021), the fictional
-- broker portal's loads (0021; each names a load the replace deletes, and only the seed's admin
-- login writes them back, so the portal has no loads until npm run seed runs again), the voice
-- notes' recordings and the voice notes (0013, 0012; each names an inbound message the replace
-- deletes), the driver notes, the agent's turn steps, the advances an approval created (they name
-- a proposal), the proposals, turns and conversations. Children go first, so each count is the
-- rows that table lost; a portal run and its session name each other, so those two go in one
-- statement, whose foreign keys are checked at its end. A row that still names a deleted one
-- makes the delete fail and the whole transaction roll back. The caller then rewrites the seeded
-- tables as payday_app, under row-level security, in the same transaction (src/lib/seed/reset.ts),
-- so a failure anywhere leaves the carrier as it was. Nothing else is touched: logins, model
-- charges, spend alerts, the gateway's audit log (a deleted turn only clears its turn_id there),
-- the portal's sign-in account, the QuickBooks link and every other tenant stay as they are. It
-- returns one row per table it deleted from, with the count.
--
-- Errors, a custom SQLSTATE class read by src/lib/seed/reset.ts:
--   LR001  no tenant is set for the transaction
--   LR002  the tenant is not a demo carrier
--   LR003  open, amount_mismatch or flagged rows, nothing was cleared
CREATE FUNCTION demo_reset_clear()
  RETURNS TABLE (table_name text, deleted bigint)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_tenant        uuid := public.current_tenant_id();
  v_slug          text;
  v_name          text;
  v_timezone      text;
  v_open          bigint;
  v_mismatch      bigint;
  v_flagged       bigint;
  v_ledger        bigint;
  v_documents     bigint;
  v_clips         bigint;
  v_portal_evid   bigint;
  v_portal_checks bigint;
  v_portal_steps  bigint;
  v_portal_sess   bigint;
  v_portal_runs   bigint;
  v_portal_loads  bigint;
  v_audio         bigint;
  v_voice_notes   bigint;
  v_notes         bigint;
  v_steps         bigint;
  v_advances      bigint;
  v_proposals     bigint;
  v_turns         bigint;
  v_conversations bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'demo reset: no tenant is set' USING ERRCODE = 'LR001';
  END IF;

  SELECT t.slug, t.name, t.timezone INTO v_slug, v_name, v_timezone
    FROM public.tenants t WHERE t.id = v_tenant FOR UPDATE;
  -- Whole values, all three from the same carrier. A NULL makes the IN unknown, which refuses too.
  IF NOT FOUND OR ((v_slug, v_name, v_timezone) IN (
       ('blue-ridge', 'Blue Ridge Freight Lines', 'America/New_York'),
       ('prairie-wind', 'Prairie Wind Transport', 'America/Chicago'))) IS NOT TRUE THEN
    RAISE EXCEPTION 'demo reset: not a demo tenant' USING ERRCODE = 'LR002';
  END IF;

  SELECT count(*) FILTER (WHERE m.state IN ('reserved', 'sent', 'unknown')),
         count(*) FILTER (WHERE m.failure_category = 'amount_mismatch')
    INTO v_open, v_mismatch
    FROM public.money_actions m
   WHERE m.tenant_id = v_tenant;
  SELECT count(*) INTO v_flagged
    FROM public.proposals p
   WHERE p.tenant_id = v_tenant AND p.flagged_input_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.money_actions m
                  WHERE m.tenant_id = v_tenant AND m.proposal_id = p.id);
  IF v_open <> 0 OR v_mismatch <> 0 OR v_flagged <> 0 THEN
    RAISE EXCEPTION 'demo reset refused: % open ledger row(s), % amount_mismatch row(s), % flagged proposal(s), nothing was cleared',
      v_open, v_mismatch, v_flagged
      USING ERRCODE = 'LR003';
  END IF;

  DELETE FROM public.money_actions m
   WHERE m.tenant_id = v_tenant AND m.state IN ('confirmed', 'failed')
     AND m.failure_category IS DISTINCT FROM 'amount_mismatch';
  GET DIAGNOSTICS v_ledger = ROW_COUNT;

  DELETE FROM public.documents d WHERE d.tenant_id = v_tenant;
  GET DIAGNOSTICS v_documents = ROW_COUNT;

  DELETE FROM public.evidence_clips ec WHERE ec.tenant_id = v_tenant;
  GET DIAGNOSTICS v_clips = ROW_COUNT;

  DELETE FROM public.portal_evidence pe WHERE pe.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_evid = ROW_COUNT;

  DELETE FROM public.portal_run_checks pc WHERE pc.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_checks = ROW_COUNT;

  DELETE FROM public.portal_run_steps ps WHERE ps.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_steps = ROW_COUNT;

  -- A run names its session and the session names its run: both go in this one statement.
  WITH gone_sessions AS (
    DELETE FROM public.portal_sessions px WHERE px.tenant_id = v_tenant RETURNING 1
  ), gone_runs AS (
    DELETE FROM public.portal_runs pr WHERE pr.tenant_id = v_tenant RETURNING 1
  )
  SELECT (SELECT count(*) FROM gone_sessions), (SELECT count(*) FROM gone_runs)
    INTO v_portal_sess, v_portal_runs;

  DELETE FROM public.portal_loads pl WHERE pl.tenant_id = v_tenant;
  GET DIAGNOSTICS v_portal_loads = ROW_COUNT;

  DELETE FROM public.voice_note_audio r WHERE r.tenant_id = v_tenant;
  GET DIAGNOSTICS v_audio = ROW_COUNT;

  DELETE FROM public.voice_notes v WHERE v.tenant_id = v_tenant;
  GET DIAGNOSTICS v_voice_notes = ROW_COUNT;

  DELETE FROM public.driver_notes n WHERE n.tenant_id = v_tenant;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  DELETE FROM public.turn_steps s WHERE s.tenant_id = v_tenant;
  GET DIAGNOSTICS v_steps = ROW_COUNT;

  DELETE FROM public.advances a WHERE a.tenant_id = v_tenant AND a.proposal_id IS NOT NULL;
  GET DIAGNOSTICS v_advances = ROW_COUNT;

  DELETE FROM public.proposals p WHERE p.tenant_id = v_tenant;
  GET DIAGNOSTICS v_proposals = ROW_COUNT;

  DELETE FROM public.turns t WHERE t.tenant_id = v_tenant;
  GET DIAGNOSTICS v_turns = ROW_COUNT;

  DELETE FROM public.conversations c WHERE c.tenant_id = v_tenant;
  GET DIAGNOSTICS v_conversations = ROW_COUNT;

  RETURN QUERY VALUES
    (CAST('money_actions' AS text), v_ledger),
    (CAST('documents' AS text), v_documents),
    (CAST('evidence_clips' AS text), v_clips),
    (CAST('portal_evidence' AS text), v_portal_evid),
    (CAST('portal_run_checks' AS text), v_portal_checks),
    (CAST('portal_run_steps' AS text), v_portal_steps),
    (CAST('portal_sessions' AS text), v_portal_sess),
    (CAST('portal_runs' AS text), v_portal_runs),
    (CAST('portal_loads' AS text), v_portal_loads),
    (CAST('voice_note_audio' AS text), v_audio),
    (CAST('voice_notes' AS text), v_voice_notes),
    (CAST('driver_notes' AS text), v_notes),
    (CAST('turn_steps' AS text), v_steps),
    (CAST('advances' AS text), v_advances),
    (CAST('proposals' AS text), v_proposals),
    (CAST('turns' AS text), v_turns),
    (CAST('conversations' AS text), v_conversations);
END
$$;

REVOKE ALL ON FUNCTION demo_reset_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_reset_clear() TO payday_app;
