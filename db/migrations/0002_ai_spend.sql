-- The model spend ledger: one row per model call, reserved before the call and settled after,
-- and one global counter, because the credit the calls draw on is one. Units are nanocents
-- (1 cent = 1,000,000,000), so every listed token price is an exact integer. The ledger never
-- holds prompt text, tool arguments, model output, keys, emails or names.

CREATE TABLE ai_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('meta', 'baseten')),
  model              text NOT NULL CHECK (length(model) BETWEEN 3 AND 80),
  purpose            text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{2,39}$'),
  status             text NOT NULL CHECK (status IN ('reserved', 'ok', 'incomplete', 'failed', 'unknown')),
  failure            text CHECK (failure IN ('rate_limited', 'unavailable', 'timeout', 'bad_request',
                       'auth', 'billing', 'too_long', 'network', 'unknown')),
  reserved_nanocents bigint NOT NULL CHECK (reserved_nanocents >= 0),
  cost_nanocents     bigint CHECK (cost_nanocents >= 0),
  input_tokens       integer CHECK (input_tokens >= 0),
  cached_tokens      integer CHECK (cached_tokens >= 0),
  output_tokens      integer CHECK (output_tokens >= 0),
  reasoning_tokens   integer CHECK (reasoning_tokens >= 0),
  upstream_id        text CHECK (length(upstream_id) <= 120),
  http_status        smallint,
  duration_ms        integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz
);
CREATE INDEX ai_calls_tenant_created_idx ON ai_calls (tenant_id, created_at DESC);
ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_calls
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE: a ledger row is the record of a charge.
GRANT SELECT, INSERT, UPDATE ON ai_calls TO payday_app;

-- Global operational rows: one credit shared by every tenant. Not tenant data, so not in public,
-- where every table is tenant data under forced row-level security.
CREATE SCHEMA ops;
CREATE TABLE ops.ai_spend (
  id                 smallint PRIMARY KEY CHECK (id = 1),
  spent_nanocents    bigint NOT NULL DEFAULT 0 CHECK (spent_nanocents >= 0),
  reserved_nanocents bigint NOT NULL DEFAULT 0 CHECK (reserved_nanocents >= 0),
  calls              bigint NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops.ai_spend (id) VALUES (1);
-- One row by construction: the app reads and updates it, never inserts or deletes.
GRANT USAGE ON SCHEMA ops TO payday_app;
GRANT SELECT, UPDATE ON ops.ai_spend TO payday_app;
