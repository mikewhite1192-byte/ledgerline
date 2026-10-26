-- Tenants and memberships, with row-level security that fails closed.
--
-- Every tenant table carries tenant_id, ENABLE and FORCE row-level security, and one policy
-- tenant_isolation scoped to current_tenant_id(). The app role payday_app owns nothing, cannot
-- bypass RLS and cannot read schema_migrations. Tables belong to the migrating admin; FORCE makes
-- even the owner name a tenant before it sees a row.

-- Roles are cluster-wide, so a cluster that already has the role keeps it. No password here: the
-- migration runner sets it on Aurora from the app secret; local and CI databases use trust auth.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payday_app') THEN
    CREATE ROLE payday_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- The runner creates this same table before the first migration so it can record this file.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Unset or empty gives NULL, and tenant_id = NULL is never true: reads return no rows and writes
-- fail with 42501. A value that is not a UUID fails the cast with 22P02.
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT CAST(NULLIF(current_setting('app.tenant_id', true), '') AS uuid) $$;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  name       text NOT NULL,
  timezone   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cognito_sub text NOT NULL UNIQUE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memberships_tenant_id_idx ON memberships (tenant_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Data access only. No grant on schema_migrations: the app cannot see it.
GRANT USAGE ON SCHEMA public TO payday_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, memberships TO payday_app;
