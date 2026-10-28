-- The judge role: a demo visitor who reads what staff read, asks the agent and proposes, and never
-- approves, pays, posts, sends or changes a setting (src/lib/auth/role.ts; every write route and
-- server action outside src/lib/auth/judge-allowlist.ts refuses it).
--
-- Three additive changes, nothing dropped but the role check it widens:
-- 1. memberships_role_check (the name Postgres gave 0001's column check, confirmed on a fresh
--    database) allows 'judge' too. The new constraint keeps the same name, so a later migration
--    finds it where it always was.
-- 2. demo_sessions: one row per demo visit, the budget the sign-in (a later change) hangs a
--    visitor's model spend and turn count on. The table follows db/README.md: tenant_id with ON
--    DELETE CASCADE, ENABLE and FORCE row-level security and the one tenant_isolation policy.
--    Grants are narrower than the README's default: SELECT, INSERT and an UPDATE of the four
--    running columns only, and no DELETE. A visit's spend is a record; the demo reset keeps it
--    (src/lib/seed/reset.ts, DEMO_RESET_KEPT), so a reset never refills a visit's budget, and
--    demo_reset_clear() does not change. Deleting a tenant removes its visits through the cascade.
-- 3. conversations.demo_session_id: the visit a conversation belongs to, null for every staff and
--    admin conversation. No foreign key: the reset deletes conversations and keeps demo_sessions,
--    like model_calls.
--
-- Rows hold ids, amounts in nanocents (one cent is 1,000,000,000), a count, timestamps and an
-- optional SHA-256 of an address. No raw address, prompt or model output is stored.

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('admin', 'staff', 'judge'));

CREATE TABLE demo_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The judge login's token subject.
  cognito_sub        text NOT NULL CHECK (length(cognito_sub) BETWEEN 1 AND 128),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  -- What the visit's model calls cost, settled and still reserved.
  spent_nanocents    bigint NOT NULL DEFAULT 0 CHECK (spent_nanocents >= 0),
  reserved_nanocents bigint NOT NULL DEFAULT 0 CHECK (reserved_nanocents >= 0),
  turns              integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  -- The salted SHA-256 hex of the visitor's address, or null. Never the address itself.
  ip_hash            text CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at),
  UNIQUE (tenant_id, id)
);

CREATE INDEX demo_sessions_tenant_created_idx ON demo_sessions (tenant_id, created_at);
CREATE INDEX demo_sessions_ip_hash_idx ON demo_sessions (ip_hash);

ALTER TABLE demo_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON demo_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON demo_sessions TO payday_app;
GRANT UPDATE (last_seen_at, spent_nanocents, reserved_nanocents, turns) ON demo_sessions TO payday_app;

ALTER TABLE conversations ADD COLUMN demo_session_id uuid;
-- Only a visit's conversations are looked up by visit; staff and admin ones (null) stay out of it.
CREATE INDEX conversations_tenant_demo_session_idx ON conversations (tenant_id, demo_session_id)
  WHERE demo_session_id IS NOT NULL;
