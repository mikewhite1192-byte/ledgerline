-- VISIT COPIES (0091): each demo visit can get its own copy of the demo carrier
-- (src/lib/visit-copy, behind flags.visitCopies).
--
-- 1. demo_sessions (0043) gains the copy a visit's ticket points at: copy_tenant_id (the copy
--    carrier's tenants.id) and copy_session_id (the visit row inside the copy that its model spend
--    and turns are counted on), both chosen once by the sign-in and set together or not at all;
--    copy_ready_at, set once the copy is built whole; and copy_deleted_at, set once the copy has
--    been purged. All four are null on every existing row, so every existing row passes the
--    checks below and a ticket with no copy reads as it always has. No foreign key from
--    copy_tenant_id: the copy is deleted on its own and the ticket keeps its record.
-- 2. The app may update these four columns; 0043's grant on the others stays as it was.
-- 3. A partial index finds the copies the purge may delete (a ticket's copy set, not yet deleted)
--    by home tenant and expiry.
-- 4. tenants (0001) gains demo_copy_of: the slug of the demo carrier a copy was built from, null
--    on every other carrier, in the same shape as a slug. The app already may update tenants.
-- 5. ops.ai_spend (0002, 0003) gains what the purge removed from the model call log: deleting a
--    copy's tenants row deletes its model_calls rows with it (ON DELETE CASCADE), while the
--    shared counters keep every cent spent, so the model calls invariant (I4,
--    src/lib/invariants/model-calls.ts) compares each counter with the log plus what was purged.
--    The purge adds a copy's totals here in the same transaction that deletes it. Every column
--    starts at 0, so the invariant reads exactly as before until a copy is purged. The app may
--    update these five columns, and the counters' grant stays as it was.
--
-- demo_reset_clear is unchanged: demo_sessions and tenants stay kept by the demo reset.
-- Additive only: nothing is dropped or rewritten, and a second run is refused by the migrator's
-- own record, not by this file.

-- 1. The copy a visit's ticket points at.
ALTER TABLE demo_sessions
  ADD COLUMN copy_tenant_id uuid,
  ADD COLUMN copy_session_id uuid,
  ADD COLUMN copy_ready_at timestamptz,
  ADD COLUMN copy_deleted_at timestamptz,
  ADD CONSTRAINT demo_sessions_copy_pair CHECK ((copy_tenant_id IS NULL) = (copy_session_id IS NULL)),
  ADD CONSTRAINT demo_sessions_copy_ready CHECK (copy_ready_at IS NULL OR copy_tenant_id IS NOT NULL);

-- 2. The app sets the copy columns and nothing else new.
GRANT UPDATE (copy_tenant_id, copy_session_id, copy_ready_at, copy_deleted_at) ON demo_sessions TO payday_app;

-- 3. The purge's lookup.
CREATE INDEX demo_sessions_copy_purge_idx ON demo_sessions (tenant_id, expires_at)
  WHERE copy_tenant_id IS NOT NULL AND copy_deleted_at IS NULL;

-- 4. Which demo carrier a copy was built from.
ALTER TABLE tenants
  ADD COLUMN demo_copy_of text,
  ADD CONSTRAINT tenants_demo_copy_of_shape CHECK (demo_copy_of ~ '^[a-z0-9-]{3,40}$');

-- 5. What the purge removed from the model call log.
ALTER TABLE ops.ai_spend
  ADD COLUMN purged_spent_nanocents           bigint NOT NULL DEFAULT 0 CHECK (purged_spent_nanocents >= 0),
  ADD COLUMN purged_reserved_nanocents        bigint NOT NULL DEFAULT 0 CHECK (purged_reserved_nanocents >= 0),
  ADD COLUMN purged_calls                     bigint NOT NULL DEFAULT 0 CHECK (purged_calls >= 0),
  ADD COLUMN purged_wonder_spent_nanocents    bigint NOT NULL DEFAULT 0 CHECK (purged_wonder_spent_nanocents >= 0),
  ADD COLUMN purged_wonder_reserved_nanocents bigint NOT NULL DEFAULT 0 CHECK (purged_wonder_reserved_nanocents >= 0);
GRANT UPDATE (purged_spent_nanocents, purged_reserved_nanocents, purged_calls,
              purged_wonder_spent_nanocents, purged_wonder_reserved_nanocents)
  ON ops.ai_spend TO payday_app;
