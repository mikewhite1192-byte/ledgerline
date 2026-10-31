-- TMS-MIRROR (0075): a read-only mirror of a dispatch system (a TMS), built for the worst case:
-- no change feed, stale list rows, hard deletes and two clocks on every time. The sync
-- (src/lib/tms/sync.ts) walks the list newest created first, re-reads each candidate in full, and
-- writes one transaction per load. Nothing here is ever sent anywhere and nothing moves money: a
-- status event can move one of our loads only through src/lib/loads/movement.ts, behind both
-- flags.tmsSync and flags.loadMovement.
--
-- 1. Seven tables, each with tenant_id, UNIQUE (tenant_id, id), forced row-level security and the
--    tenant_isolation policy. All seven are seeded tables (src/lib/data/tables.ts), so the seed's
--    replace and the demo reset clear them; demo_reset_clear() is not re-created.
--    tms_connections: one per tenant, the system, the tenant's status label map, the document
--      lookback, the finalize cool-off, a token cache slot (unused by the synthetic feed), the
--      fault switches (all false; a later item), the synthetic feed's clock floor (the seeded
--      snapshot's instant), and the last full pass.
--    tms_parties: customers, drivers, trucks and trailers as the TMS names them, linked to ours
--      by whole value only (customers.code, driver_identities.external_id).
--    tms_loads: the full record of each load, its three resolved times (both clocks, the moment,
--      the day), the link to our load by whole load number, the read bookkeeping (attempts, the
--      rest mark, the finalize recheck, the pass marker, the tombstone) and bounded flags.
--    tms_stops, tms_line_items, tms_documents: a load's stops, lines and document metadata (never
--      a file, never a file address). review_state is ours alone.
--    tms_status_events: the load's history, one row per TMS event id (the dedupe for history
--      pages read twice). Never changed: no UPDATE grant.
-- 2. load_events gains source 'tms' with evidence table 'tms_status_events' (the event that moved
--    the load). The three checks are re-created NOT VALID; 0075_tms_mirror_validate.sql validates
--    them.
-- 3. desk_log's source check: 0071's list whole plus 'tms_event', NOT VALID, validated next.

CREATE TABLE tms_connections (
  id                       uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system                   text NOT NULL CHECK (system IN ('synthetic')),
  label_map                jsonb NOT NULL CHECK (jsonb_typeof(label_map) = 'object'),
  lookback_hours           integer NOT NULL CHECK (lookback_hours BETWEEN 1 AND 48),
  finalize_cooloff_minutes integer NOT NULL CHECK (finalize_cooloff_minutes BETWEEN 1 AND 1440),
  token_cache              text CHECK (length(token_cache) BETWEEN 1 AND 4096),
  token_expires_at         timestamptz,
  demo_faults              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(demo_faults) = 'object'),
  feed_floor_at            timestamptz,
  last_walk_started_at     timestamptz,
  last_walk_completed_at   timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_cache IS NULL) = (token_expires_at IS NULL)),
  UNIQUE (tenant_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE tms_parties (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('customer', 'driver', 'truck', 'trailer')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  unit        text CHECK (length(unit) BETWEEN 1 AND 40),
  vin         text CHECK (length(vin) BETWEEN 1 AND 40),
  customer_id uuid,
  driver_id   uuid,
  gone_at     timestamptz,
  received_at timestamptz NOT NULL,
  seeded      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NULL OR kind = 'customer'),
  CHECK (driver_id IS NULL OR kind = 'driver'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, external_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
);

CREATE TABLE tms_loads (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id            text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  load_id                uuid,
  reference              text NOT NULL CHECK (length(reference) BETWEEN 1 AND 64),
  status_code            text NOT NULL CHECK (status_code IN ('new', 'tendered', 'booked', 'in_transit', 'delivered',
                           'review', 'pay_ready', 'finalized', 'invoice_hold', 'invoiced', 'paid', 'on_hold',
                           'breakdown', 'claim', 'board', 'archived', 'expired', 'cancelled', 'custom')),
  status_label           text NOT NULL CHECK (length(status_label) BETWEEN 1 AND 60),
  customer_external_id   text CHECK (length(customer_external_id) BETWEEN 1 AND 64),
  driver_external_id     text CHECK (length(driver_external_id) BETWEEN 1 AND 64),
  truck_unit             text CHECK (length(truck_unit) BETWEEN 1 AND 40),
  trailer_unit           text CHECK (length(trailer_unit) BETWEEN 1 AND 40),
  vin                    text CHECK (length(vin) BETWEEN 1 AND 40),
  stop_count             integer NOT NULL CHECK (stop_count BETWEEN 0 AND 1000),
  leg_count              integer NOT NULL CHECK (leg_count BETWEEN 0 AND 1000),
  -- Each time three ways: the UTC field as given, the local field as given, then the moment and
  -- the day our two-clock rule resolved (src/lib/tms/clocks.ts).
  picked_up_utc          timestamptz,
  picked_up_local        text CHECK (picked_up_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  picked_up_at           timestamptz,
  picked_up_day          date,
  delivered_utc          timestamptz,
  delivered_local        text CHECK (delivered_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  delivered_at           timestamptz,
  delivered_day          date,
  last_completed_utc     timestamptz,
  last_completed_local   text CHECK (last_completed_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  last_completed_at      timestamptz,
  last_completed_day     date,
  revenue_total_cents    integer,
  driver_pay_total_cents integer,
  source_updated_at      timestamptz NOT NULL,
  finalized_at           timestamptz,
  received_at            timestamptz NOT NULL,
  -- Reads that threw since the last good one; at 10 the load rests until rest_updated_at moves.
  read_attempts          integer NOT NULL DEFAULT 0 CHECK (read_attempts BETWEEN 0 AND 1000),
  rest_updated_at        timestamptz,
  recheck_after          timestamptz,
  finalized_seen_at      timestamptz,
  gone_at                timestamptz,
  -- The last pass that listed (or verified) this load.
  listed_at              timestamptz,
  flags                  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(flags) = 'array' AND jsonb_array_length(flags) <= 10),
  seeded                 boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((picked_up_local IS NULL) = (picked_up_at IS NULL) AND (picked_up_at IS NULL) = (picked_up_day IS NULL)),
  CHECK (picked_up_utc IS NULL OR picked_up_local IS NOT NULL),
  CHECK ((delivered_local IS NULL) = (delivered_at IS NULL) AND (delivered_at IS NULL) = (delivered_day IS NULL)),
  CHECK (delivered_utc IS NULL OR delivered_local IS NOT NULL),
  CHECK ((last_completed_local IS NULL) = (last_completed_at IS NULL) AND (last_completed_at IS NULL) = (last_completed_day IS NULL)),
  CHECK (last_completed_utc IS NULL OR last_completed_local IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
CREATE UNIQUE INDEX tms_loads_one_per_load ON tms_loads (tenant_id, load_id) WHERE load_id IS NOT NULL;

CREATE TABLE tms_stops (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tms_load_id     uuid NOT NULL,
  -- Our order: pickups as given, then deliveries as given.
  ordinal         integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  stop_kind       text NOT NULL CHECK (stop_kind IN ('pickup', 'delivery')),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  city            text NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
  state           text NOT NULL CHECK (length(state) BETWEEN 1 AND 40),
  appt_from_local text CHECK (appt_from_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  appt_to_local   text CHECK (appt_to_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  -- Windows carry no zone: read in the carrier's own (tenants.timezone).
  appt_from_at    timestamptz,
  appt_to_at      timestamptz,
  arrived_utc     timestamptz,
  arrived_local   text CHECK (arrived_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  arrived_at      timestamptz,
  completed_utc   timestamptz,
  completed_local text CHECK (completed_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((appt_from_local IS NULL) = (appt_from_at IS NULL)),
  CHECK ((appt_to_local IS NULL) = (appt_to_at IS NULL)),
  CHECK ((arrived_local IS NULL) = (arrived_at IS NULL) AND (arrived_utc IS NULL OR arrived_local IS NOT NULL)),
  CHECK ((completed_local IS NULL) = (completed_at IS NULL) AND (completed_utc IS NULL OR completed_local IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tms_load_id, ordinal),
  FOREIGN KEY (tenant_id, tms_load_id) REFERENCES tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tms_status_events (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tms_load_id       uuid NOT NULL,
  external_event_id text NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 64),
  field             text NOT NULL CHECK (length(field) BETWEEN 1 AND 60),
  new_value         text CHECK (length(new_value) BETWEEN 1 AND 120),
  previous_value    text CHECK (length(previous_value) BETWEEN 1 AND 120),
  changed_by        text CHECK (length(changed_by) BETWEEN 0 AND 80),
  at_utc            timestamptz,
  at_local          text NOT NULL CHECK (at_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  at                timestamptz NOT NULL,
  day               date NOT NULL,
  clock_flag        text CHECK (clock_flag IN ('clocks_disagree')),
  received_at       timestamptz NOT NULL,
  seeded            boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_event_id),
  FOREIGN KEY (tenant_id, tms_load_id) REFERENCES tms_loads (tenant_id, id) ON DELETE CASCADE
);
-- The desk loop's tms_event finder.
CREATE INDEX tms_status_events_tenant_received ON tms_status_events (tenant_id, received_at);

CREATE TABLE tms_line_items (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tms_load_id  uuid NOT NULL,
  external_id  text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  item_group   text NOT NULL CHECK (item_group IN ('revenue', 'driver_pay', 'accessorial')),
  type_label   text NOT NULL CHECK (length(type_label) BETWEEN 1 AND 60),
  description  text NOT NULL CHECK (length(description) BETWEEN 0 AND 120),
  amount_cents integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, tms_load_id) REFERENCES tms_loads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tms_documents (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tms_load_id       uuid NOT NULL,
  external_id       text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  type_label        text NOT NULL CHECK (length(type_label) BETWEEN 1 AND 60),
  doc_kind          text NOT NULL CHECK (doc_kind IN ('proof_of_pickup', 'proof_of_delivery', 'bill_of_lading',
                      'leg_bol', 'rate_confirmation', 'invoice', 'quote', 'other')),
  shared            boolean NOT NULL,
  uploader_kind     text NOT NULL CHECK (uploader_kind IN ('driver_app', 'office', 'unknown')),
  -- A placeholder row (an empty file) is never mirrored.
  byte_length       integer NOT NULL CHECK (byte_length > 0),
  source_updated_at timestamptz NOT NULL,
  review_state      text NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'fetched', 'read', 'rejected')),
  first_seen_at     timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, tms_load_id) REFERENCES tms_loads (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE tms_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_connections
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_connections TO payday_app;

ALTER TABLE tms_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_parties
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_parties TO payday_app;

ALTER TABLE tms_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_loads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_loads
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_loads TO payday_app;

ALTER TABLE tms_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_stops
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_stops TO payday_app;

ALTER TABLE tms_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_status_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No UPDATE: an event that happened never changes.
GRANT SELECT, INSERT, DELETE ON tms_status_events TO payday_app;

ALTER TABLE tms_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_line_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_line_items
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_line_items TO payday_app;

ALTER TABLE tms_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_documents
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_documents TO payday_app;

-- 2. A load moved by a dispatch event names that event. NOT VALID; validated in the next file.
ALTER TABLE load_events DROP CONSTRAINT load_events_source_check;
ALTER TABLE load_events ADD CONSTRAINT load_events_source_check
  CHECK (source IN ('driver_photo', 'driver_text', 'driver_voice', 'staff', 'demo_feed', 'seed', 'tms')) NOT VALID;
ALTER TABLE load_events DROP CONSTRAINT load_events_evidence_table_check;
ALTER TABLE load_events ADD CONSTRAINT load_events_evidence_table_check
  CHECK (evidence_table IN ('documents', 'inbound_messages', 'voice_notes', 'tms_status_events')) NOT VALID;
-- IS NOT DISTINCT FROM, never =: a NULL evidence_table must fail the check, not pass it.
ALTER TABLE load_events DROP CONSTRAINT load_events_evidence_source;
ALTER TABLE load_events ADD CONSTRAINT load_events_evidence_source CHECK (
  (source = 'driver_photo' AND evidence_table IS NOT DISTINCT FROM 'documents') OR
  (source = 'driver_text' AND evidence_table IS NOT DISTINCT FROM 'inbound_messages') OR
  (source = 'driver_voice' AND evidence_table IS NOT DISTINCT FROM 'voice_notes') OR
  (source = 'tms' AND evidence_table IS NOT DISTINCT FROM 'tms_status_events') OR
  (source IN ('staff', 'demo_feed', 'seed') AND evidence_table IS NULL)) NOT VALID;

-- 3. The desk log's sources: 0071's list whole, plus the dispatch event source.
ALTER TABLE desk_log DROP CONSTRAINT desk_log_source_check;
ALTER TABLE desk_log ADD CONSTRAINT desk_log_source_check CHECK (source IN (
  'card_transaction', 'inbound_message', 'voice_note', 'customer_payment', 'audit', 'sweep',
  'collections', 'cash_check', 'autopilot', 'document', 'load_event', 'tms_event')) NOT VALID;
