-- The agent gateway's tables: outside text the agent may be shown, the screening verdict for that
-- text, and one decision row for every tool call a model makes.
--
-- Every table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. A reference to another
-- tenant table is a composite foreign key on (tenant_id, x_id).
--
-- Grants are narrower than the README's default. No table here takes UPDATE: a screening verdict
-- and a gateway decision are written once and never changed. The decision log takes no DELETE
-- either. untrusted_inputs and screenings take DELETE only because the seed's replace mode clears
-- every seeded table as the app role before it writes the plan again.

-- One piece of text from outside the company: an email, a voice transcript or text pulled from a
-- document. driver_id is set when the sender matched a driver's address; it goes back to null if
-- that driver row is deleted (a reseed clears drivers after this table, so this never blocks it).
-- content_hash is the sha256 hex of kind, a newline and body_text: the screening cache key.
CREATE TABLE untrusted_inputs (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('email', 'transcript', 'document')),
  source       text NOT NULL
                 CHECK (source IN ('inbound', 'upload', 'voice', 'seed_benign', 'seed_injection')),
  driver_id    uuid,
  from_address text CHECK (from_address IS NULL OR length(from_address) <= 320),
  subject      text CHECK (subject IS NULL OR length(subject) <= 300),
  body_text    text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 200000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  received_at  timestamptz NOT NULL,
  seed_key     text CHECK (seed_key IS NULL OR seed_key ~ '^[a-z0-9-]{3,80}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((seed_key IS NULL) = (source NOT IN ('seed_benign', 'seed_injection'))),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, seed_key),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE SET NULL (driver_id)
);
CREATE INDEX untrusted_inputs_tenant_received ON untrusted_inputs (tenant_id, received_at DESC);
ALTER TABLE untrusted_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE untrusted_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON untrusted_inputs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The screening verdict for one text, never the text itself. A verdict is cached by
-- (tenant, content_hash, screener_version). A failed screen (via = 'error') is stored as flagged
-- with expires_at ten minutes on, so an outage never marks a message for good: the unique key is
-- a partial index that leaves those rows out, and the cache read skips them once expired.
-- confidence_milli is the screener's confidence from 0 to 1000 (an integer, so both database
-- drivers return the same number).
CREATE TABLE screenings (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  input_id         uuid NOT NULL,
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  screener_version smallint NOT NULL DEFAULT 1 CHECK (screener_version > 0),
  verdict          text NOT NULL CHECK (verdict IN ('clean', 'flagged')),
  categories       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(categories) = 'array'),
  confidence_milli integer CHECK (confidence_milli BETWEEN 0 AND 1000),
  via              text NOT NULL CHECK (via IN ('model', 'cache', 'pattern', 'error')),
  model_call_id    uuid,
  latency_ms       integer NOT NULL CHECK (latency_ms >= 0),
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((expires_at IS NOT NULL) = (via = 'error')),
  CHECK (via <> 'error' OR verdict = 'flagged'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, input_id) REFERENCES untrusted_inputs (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX screenings_cache_key ON screenings (tenant_id, content_hash, screener_version)
  WHERE expires_at IS NULL;
CREATE INDEX screenings_tenant_input ON screenings (tenant_id, input_id);
ALTER TABLE screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON screenings
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One row per tool call a model makes through the gateway, whatever the outcome. args_redacted
-- keeps ids, whole numbers, dates and enum values; every other string is replaced by its length.
-- tier is null only for a tool name the registry does not hold. turn_id gains its foreign key
-- once the turns table exists.
CREATE TABLE gateway_decisions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  turn_id         uuid,
  trace_id        text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 64),
  role            text NOT NULL CHECK (role IN ('operator', 'auditor', 'triage')),
  model           text NOT NULL CHECK (model IN ('spark', 'wonder', 'spark_open')),
  tool            text NOT NULL CHECK (tool ~ '^[a-z_]{3,40}$'),
  tier            text CHECK (tier IN ('read', 'propose', 'record')),
  args_redacted   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(args_redacted) = 'object'),
  refs            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(refs) = 'array'),
  decision        text NOT NULL CHECK (decision IN ('allowed', 'blocked', 'invalid_args', 'denied',
                    'unknown_tool', 'failed')),
  reason          text NOT NULL CHECK (reason ~ '^[a-z_]{2,40}$'),
  limit_cents     bigint CHECK (limit_cents >= 0 AND limit_cents < 1000000000),
  requested_cents bigint CHECK (requested_cents > -1000000000 AND requested_cents < 1000000000),
  result_chars    integer CHECK (result_chars >= 0),
  model_call_id   uuid,
  latency_ms      integer NOT NULL CHECK (latency_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((tier IS NULL) = (decision = 'unknown_tool'))
);
CREATE INDEX gateway_decisions_tenant_trace ON gateway_decisions (tenant_id, trace_id);
CREATE INDEX gateway_decisions_tenant_created ON gateway_decisions (tenant_id, created_at DESC);
ALTER TABLE gateway_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gateway_decisions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, DELETE ON untrusted_inputs, screenings TO payday_app;
GRANT SELECT, INSERT ON gateway_decisions TO payday_app;
