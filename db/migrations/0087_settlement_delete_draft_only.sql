-- SETTLEMENT DELETE DRAFT ONLY (0087): the app role may remove a draft paystub (the pay run's
-- re-run does) and nothing else. An approved or paid settlement is a pay record; a stray delete
-- of one now raises instead of erasing it.
--
-- A trigger, not a second policy: every tenant table holds exactly one policy (the catalog
-- invariant and rls-coverage.db.test.ts check it). Let through, each on purpose:
--   - a draft, at any login;
--   - the carrier's own removal (the tenants foreign key's cascade runs inside the cascade
--     trigger, so its depth is above one, as desk_log_guard does in 0065);
--   - any login other than payday_app (migrations, scripts and the tests' admin pool);
--   - the seed's replace (deleteTenantRows in src/lib/data/writer.ts), which removes the
--     tenant's paid rows on purpose as the app role and first marks its own transaction with
--     set_config('app.tenant_wipe', <tenant id>, true). The mark dies at commit or rollback.
--     The app role can set it too, so this stops bugs and stray queries, not a deliberate wipe.
--
-- Invoker rights, owned by the migrating admin. The raise (check_violation) rolls the
-- transaction back and names no id or amount. No row changes, so no _validate file.
--
-- Down: DROP TRIGGER IF EXISTS settlements_delete_guard ON settlements;
--       DROP FUNCTION IF EXISTS settlements_delete_guard();
CREATE FUNCTION settlements_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN OLD;
  END IF;
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF current_user <> 'payday_app' THEN
    RETURN OLD;
  END IF;
  IF current_setting('app.tenant_wipe', true) = CAST(OLD.tenant_id AS text) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'settlements: only a draft can be removed'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER settlements_delete_guard
  BEFORE DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION settlements_delete_guard();
