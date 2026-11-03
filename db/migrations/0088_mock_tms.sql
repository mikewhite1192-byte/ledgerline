-- MOCK TMS (0088): a sample dispatch system inside the app (/tms-demo), so a person can move a
-- load through its statuses and the desk reads it the way it would read a real one. It is its own
-- store: LedgerLine reads it only through the read-only TmsSource adapter `mock`
-- (src/lib/adapters/tms-source/mock.ts), exactly as it reads the synthetic feed, and the only
-- writes here are a person's clicks on the sample system's pages (src/lib/mock-tms/store.ts).
-- Nothing here moves money, and nothing is ever sent anywhere but our own webhook route.
--
-- 1. Six tables, each with tenant_id, UNIQUE (tenant_id, id), forced row-level security and the
--    tenant_isolation policy. All six are seeded tables (src/lib/data/tables.ts), so the seed's
--    replace and the demo reset rewrite them to the seeded board; demo_reset_clear() is not
--    re-created. Ids are the synthetic feed's on purpose (`syn:<slug>:<loadNumber>` and its
--    suffixes), so the store at the seeded instant is the mirror's seeded snapshot, id for id.
--    mock_tms_loads: one load as the sample system keeps it; its times are single instants (both
--      clocks are served from one instant in the carrier's zone), its revenue total is the sum of
--      its lines, never stored. last_hook_at and last_hook_result keep the category of the last
--      webhook send, never a key, an address or a body.
--    mock_tms_stops, mock_tms_lines, mock_tms_documents: a load's stops, lines and document
--      metadata (never a file, never a file address; a zero byte_length is a placeholder the
--      mirror skips, on purpose).
--    mock_tms_events: a load's history, one row per click (seq per load). Never changed: no
--      UPDATE grant. The dedupe keys are (tenant_id, mock_load_id, seq) and (tenant_id, external_id).
--    mock_tms_parties: customers, drivers and trucks as the sample system names them.
-- 2. tms_connections.system: 0075's check plus 'mock', NOT VALID, validated by
--    0088_mock_tms_validate.sql. Every row already there is 'synthetic', which the new check still
--    allows, so no row needs narrowing first.

CREATE TABLE mock_tms_loads (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id          text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  reference            text NOT NULL CHECK (length(reference) BETWEEN 1 AND 64),
  status_label         text NOT NULL CHECK (length(status_label) BETWEEN 1 AND 60),
  customer_external_id text CHECK (length(customer_external_id) BETWEEN 1 AND 64),
  customer_name        text CHECK (length(customer_name) BETWEEN 1 AND 120),
  driver_external_id   text CHECK (length(driver_external_id) BETWEEN 1 AND 64),
  truck_unit           text CHECK (length(truck_unit) BETWEEN 1 AND 40),
  trailer_unit         text CHECK (length(trailer_unit) BETWEEN 1 AND 40),
  vin                  text CHECK (length(vin) BETWEEN 1 AND 40),
  picked_up_at         timestamptz,
  delivered_at         timestamptz,
  last_completed_at    timestamptz,
  finalized_at         timestamptz,
  -- The sample system's own created and updated times (the list walk's order and its change mark).
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  last_hook_at         timestamptz,
  last_hook_result     text CHECK (last_hook_result ~ '^(sent|not_configured|hook_off|timeout|unreachable|refused_[0-9]{3})$'),
  seeded               boolean NOT NULL DEFAULT false,
  CHECK ((customer_external_id IS NULL) = (customer_name IS NULL)),
  CHECK ((last_hook_at IS NULL) = (last_hook_result IS NULL)),
  CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  UNIQUE (tenant_id, reference)
);
-- The adapter's list walk: newest created first, ties by id, below a bookmark.
CREATE INDEX mock_tms_loads_walk ON mock_tms_loads (tenant_id, created_at DESC, external_id DESC);

CREATE TABLE mock_tms_stops (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mock_load_id    uuid NOT NULL,
  ordinal         integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  stop_kind       text NOT NULL CHECK (stop_kind IN ('pickup', 'delivery')),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  city            text NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
  state           text NOT NULL CHECK (length(state) BETWEEN 1 AND 40),
  -- Windows carry no zone, as a real system's do.
  appt_from_local text CHECK (appt_from_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  appt_to_local   text CHECK (appt_to_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  arrived_at      timestamptz,
  completed_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, mock_load_id, ordinal),
  FOREIGN KEY (tenant_id, mock_load_id) REFERENCES mock_tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE mock_tms_events (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mock_load_id   uuid NOT NULL,
  seq            integer NOT NULL CHECK (seq BETWEEN 1 AND 100000),
  external_id    text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  field          text NOT NULL CHECK (length(field) BETWEEN 1 AND 60),
  new_value      text CHECK (length(new_value) BETWEEN 1 AND 120),
  previous_value text CHECK (length(previous_value) BETWEEN 1 AND 120),
  -- A role word ("Dispatch desk", "Driver app"), never a person's name or address.
  changed_by     text CHECK (length(changed_by) BETWEEN 1 AND 80),
  at             timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, mock_load_id, seq),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, mock_load_id) REFERENCES mock_tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE mock_tms_lines (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mock_load_id uuid NOT NULL,
  external_id  text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  item_group   text NOT NULL CHECK (item_group IN ('revenue', 'driver_pay', 'accessorial')),
  type_label   text NOT NULL CHECK (length(type_label) BETWEEN 1 AND 60),
  description  text NOT NULL CHECK (length(description) BETWEEN 0 AND 120),
  amount_cents integer NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, mock_load_id) REFERENCES mock_tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE mock_tms_documents (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mock_load_id  uuid NOT NULL,
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  type_label    text NOT NULL CHECK (length(type_label) BETWEEN 1 AND 60),
  shared        boolean NOT NULL,
  uploader_kind text NOT NULL CHECK (uploader_kind IN ('driver_app', 'office', 'unknown')),
  byte_length   integer NOT NULL CHECK (byte_length BETWEEN 0 AND 50000000),
  updated_at    timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, mock_load_id) REFERENCES mock_tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE mock_tms_parties (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('customer', 'driver', 'truck', 'trailer')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  unit        text CHECK (length(unit) BETWEEN 1 AND 40),
  vin         text CHECK (length(vin) BETWEEN 1 AND 40),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, external_id)
);

ALTER TABLE mock_tms_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_loads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_loads
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_tms_loads TO payday_app;

ALTER TABLE mock_tms_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_stops
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_tms_stops TO payday_app;

-- History never changes: no UPDATE.
ALTER TABLE mock_tms_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, DELETE ON mock_tms_events TO payday_app;

ALTER TABLE mock_tms_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_lines
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_tms_lines TO payday_app;

ALTER TABLE mock_tms_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_documents
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_tms_documents TO payday_app;

ALTER TABLE mock_tms_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE mock_tms_parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mock_tms_parties
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mock_tms_parties TO payday_app;

-- 2. The connection's systems: 0075's list whole, plus the sample dispatch system.
ALTER TABLE tms_connections DROP CONSTRAINT tms_connections_system_check;
ALTER TABLE tms_connections ADD CONSTRAINT tms_connections_system_check CHECK (system IN ('synthetic', 'mock')) NOT VALID;
