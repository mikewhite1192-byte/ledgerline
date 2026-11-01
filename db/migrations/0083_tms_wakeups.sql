-- TMS WAKE-UPS (0083): the dispatch system's webhook, a wake-up only (docs: TMS-MIRROR T4). Its
-- payload is never trusted for content: the route (src/app/api/internal/tms-hook/[tenant]) reads
-- two fields, the record type and the external id, keeps a wake-up row, and wakes the desk loop;
-- the sync (src/lib/tms/sync.ts) re-reads those records in full, first. Nothing here is sent
-- anywhere and nothing moves money.
--
-- 1. tms_wakeups: one row per record waiting to be read again. The dedupe key is the partial
--    UNIQUE tms_wakeups_one_waiting on (tenant_id, record_type, external_id) WHERE processed_at
--    IS NULL: the same wake-up sent three times while it waits is one row (sent = 3). The sync
--    sets processed_at in the transaction that records the record's read (its write, tombstone
--    or failed attempt), so a wake-up after that is a new row.
--    The external id has the bounds the mirror's ids have. Processed rows older than a day are
--    removed by the sync, so the app may DELETE.
-- 2. tms_hook_minutes: the hook's rate bound, one row per tenant per minute with the calls taken
--    in it (at most flags.tmsHook.hookPerMinute). Earlier minutes are removed by the route.
-- 3. desk_log's by check: 0065's list plus 'webhook', NOT VALID, validated by
--    0083_tms_wakeups_validate.sql. Every row already there is 'schedule' or 'button', which the
--    new check still allows, so no row needs narrowing first.
--
-- Both tables name only the carrier, so the demo reset keeps them (src/lib/seed/reset.ts): a
-- wake-up kept over a reset only reads one record again.

CREATE TABLE tms_wakeups (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_type  text NOT NULL CHECK (record_type IN ('load', 'driver', 'customer')),
  external_id  text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9:._-]{1,64}$'),
  received_at  timestamptz NOT NULL,
  -- How many times it was sent while it waited (the first included). The sync marks it processed
  -- only at the count it read, so a repeat that arrives during the read keeps it waiting.
  sent         integer NOT NULL DEFAULT 1 CHECK (sent BETWEEN 1 AND 2000000000),
  processed_at timestamptz,
  -- The last failed read of a party (sync.ts); a row tried and failed waits behind every row not yet tried.
  attempted_at timestamptz,
  UNIQUE (tenant_id, id)
);
-- The dedupe key: one waiting wake-up per record.
CREATE UNIQUE INDEX tms_wakeups_one_waiting ON tms_wakeups (tenant_id, record_type, external_id)
  WHERE processed_at IS NULL;
-- The sync's take, oldest first.
CREATE INDEX tms_wakeups_waiting ON tms_wakeups (tenant_id, received_at) WHERE processed_at IS NULL;

ALTER TABLE tms_wakeups ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_wakeups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_wakeups
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_wakeups TO payday_app;

CREATE TABLE tms_hook_minutes (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The minute's first instant, by the route's clock.
  minute_at  timestamptz NOT NULL,
  accepted   integer NOT NULL CHECK (accepted BETWEEN 1 AND 100000),
  PRIMARY KEY (tenant_id, minute_at)
);

ALTER TABLE tms_hook_minutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tms_hook_minutes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tms_hook_minutes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tms_hook_minutes TO payday_app;

-- 3. The desk log's wakers: 0065's list whole, plus the dispatch webhook.
ALTER TABLE desk_log DROP CONSTRAINT desk_log_by_check;
ALTER TABLE desk_log ADD CONSTRAINT desk_log_by_check CHECK (by IN ('schedule', 'button', 'webhook')) NOT VALID;
