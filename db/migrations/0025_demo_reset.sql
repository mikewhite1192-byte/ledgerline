-- The demo reset: one delete-capable function for the two synthetic demo carriers, so a carrier
-- admin can put the demo back to its seeded week from the app (/settings/demo), with no laptop.
--
-- This breaks the 0006 convention "never security definer" on purpose, and only here. The app logs
-- in as payday_app, which has no DELETE on the money ledger (money_actions) or on the agent's
-- records (driver_notes, turn_steps, proposals, turns, conversations): they are the record of what
-- was paid and what the agent did. A reset needs exactly those rows gone for one demo carrier, and
-- an app process holds no other login, so this function runs as its owner (the migrating admin)
-- and does that one job. src/lib/db/rls-coverage.db.test.ts allows this function and no other
-- security-definer function, and checks every bound below.
--
-- What bounds it:
--   * search_path is fixed to public, then pg_temp, and every table and function it names is
--     schema-qualified, so nothing a caller creates can stand in for them (the app role has no
--     CREATE on public either, which the same test checks).
--   * EXECUTE is revoked from PUBLIC and granted to payday_app only.
--   * It acts on the calling transaction's tenant, current_tenant_id(), and on nothing else. Its
--     owner is not bound by row-level security, so every statement names that tenant itself.
--   * It refuses any tenant whose slug is not one of the two demo carriers, so a real carrier can
--     never be reset this way.
--   * It takes the tenant row lock first. Two resets of one carrier run one after the other, a
--     write already in flight for that carrier (every tenant table references tenants, and an
--     insert holds a key-share lock on its tenant row) lands before the counts are read, and no
--     new row for that carrier can be added until the reset's transaction ends.
--   * It refuses, deleting nothing, while the carrier has a ledger row still reserved, sent or
--     unknown (its outcome is not known yet), a row failed as amount_mismatch (money may have
--     moved for another amount), or a proposal flagged by an outside message that a ledger row
--     names. A person settles or reviews those first. The refusal carries counts only.
--
-- It deletes, for that tenant only: the settled ledger rows (confirmed or failed, never
-- amount_mismatch), the driver notes, the agent's turn steps, the advances an approval created
-- (they name a proposal), the proposals, turns and conversations. Children go first, so each count
-- is the rows that table lost. A row that still names a deleted one makes the delete fail and the
-- whole transaction roll back. The caller then rewrites the seeded tables as payday_app, under
-- row-level security, in the same transaction (src/lib/seed/reset.ts), so a failure anywhere
-- leaves the carrier as it was. Nothing else is touched: logins, model charges, spend alerts, the
-- gateway's audit log (a deleted turn only clears its turn_id there), the QuickBooks link and every
-- other tenant stay as they are. It returns one row per table it deleted from, with the count.
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
  v_open          bigint;
  v_mismatch      bigint;
  v_flagged       bigint;
  v_ledger        bigint;
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

  SELECT t.slug INTO v_slug FROM public.tenants t WHERE t.id = v_tenant FOR UPDATE;
  IF NOT FOUND OR v_slug IS NULL OR v_slug NOT IN ('blue-ridge', 'prairie-wind') THEN
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
