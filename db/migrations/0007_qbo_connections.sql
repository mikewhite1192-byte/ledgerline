-- Each carrier's link to its QuickBooks Online sandbox company: the OAuth tokens (encrypted by the
-- app before they reach this table), the one allowed company id, and the account and item ids the
-- adapter posts to. Plus the one-time state of a connect in progress and the outside ids of the
-- customers and drivers already created there. src/lib/adapters/accounting/qbo writes these.
--
-- Same conventions as 0004 to 0006: tenant_id, forced row-level security with the one policy,
-- composite (tenant_id, x_id) foreign keys to memberships. The token columns hold AES-256-GCM
-- ciphertext (12-byte nonce, ciphertext, 16-byte tag) sealed with a key that never reaches the
-- database, bound to the tenant and the company id, so a copied value opens nowhere else.

CREATE TABLE qbo_connections (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  realm_id                    text NOT NULL CHECK (realm_id ~ '^[0-9]{10,20}$'),
  access_token_enc            bytea NOT NULL CHECK (octet_length(access_token_enc) BETWEEN 29 AND 8192),
  refresh_token_enc           bytea NOT NULL CHECK (octet_length(refresh_token_enc) BETWEEN 29 AND 8192),
  access_expires_at           timestamptz NOT NULL,
  refresh_expires_at          timestamptz NOT NULL,
  -- Role name to the company's account id, and item name to item id. Ids only, resolved at
  -- connect; a reconnect resolves them again.
  account_map                 jsonb NOT NULL CHECK (jsonb_typeof(account_map) = 'object'),
  item_map                    jsonb NOT NULL CHECK (jsonb_typeof(item_map) = 'object'),
  connected_by_membership_id  uuid NOT NULL,
  connected_at                timestamptz NOT NULL DEFAULT now(),
  refreshed_at                timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, connected_by_membership_id) REFERENCES memberships (tenant_id, id)
);

ALTER TABLE qbo_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON qbo_connections
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A connect in progress: the random state sent to Intuit, matched whole on the way back, used
-- once (deleted) and refused after ten minutes.
CREATE TABLE qbo_oauth_states (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state          text NOT NULL UNIQUE CHECK (length(state) = 43 AND state ~ '^[A-Za-z0-9_-]+$'),
  membership_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX qbo_oauth_states_tenant_id_idx ON qbo_oauth_states (tenant_id);

ALTER TABLE qbo_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON qbo_oauth_states
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The company's id for a customer or driver this tenant already created there, so a second post
-- finds it instead of making another. Not a foreign key to the local row: a reseed replaces those
-- rows, and the outside record stays.
CREATE TABLE qbo_entity_ids (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_table  text NOT NULL CHECK (local_table IN ('customers', 'drivers')),
  local_id     uuid NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN ('Customer', 'Vendor')),
  outside_id   text NOT NULL CHECK (outside_id ~ '^[0-9]{1,20}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((local_table = 'customers') = (entity_type = 'Customer')),
  UNIQUE (tenant_id, local_table, local_id)
);

ALTER TABLE qbo_entity_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_entity_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON qbo_entity_ids
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- States are consumed and connections removed on disconnect, so both get DELETE. An entity id is
-- the record of an outside create: no UPDATE, no DELETE (it goes only with the tenant).
GRANT SELECT, INSERT, UPDATE, DELETE ON qbo_oauth_states, qbo_connections TO payday_app;
GRANT SELECT, INSERT ON qbo_entity_ids TO payday_app;
