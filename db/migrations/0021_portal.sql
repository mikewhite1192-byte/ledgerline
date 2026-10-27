-- The portal runner: a fictional broker portal served by this app, and the runs in which the
-- agent drives a browser on it to read a delivered load's check-in and check-out stamps and fetch
-- the signed POD. The portal is synthetic (seeded per tenant); a run only reads it.
--
-- Every table follows db/README.md: tenant_id, ENABLE and FORCE row-level security, the one
-- tenant_isolation policy, UNIQUE (tenant_id, id) and composite foreign keys, so no row can point
-- at another tenant's row. Ids are made by the app. Large values (screenshots, PDFs) are bytea
-- with a byte-length column checked against the cap. The app role gets only what the runner and
-- the routes need: no DELETE anywhere (the seed's admin login clears these tables first).

-- The carrier's account on the portal: the carrier number typed at sign-in. One per tenant.
-- failed_sign_ins counts the misses in the minute that began at failed_window_start; at the limit
-- the sign-in form refuses every entry, even a right one, until that minute is over.
CREATE TABLE portal_accounts (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  carrier_number      text NOT NULL UNIQUE CHECK (carrier_number ~ '^MC-[0-9]{6}$'),
  carrier_name        text NOT NULL CHECK (length(carrier_name) BETWEEN 1 AND 120),
  failed_sign_ins     integer NOT NULL DEFAULT 0 CHECK (failed_sign_ins >= 0),
  failed_window_start timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_accounts
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The broker's own record of one delivered load: its reference, the facility's stamps in the
-- facility's named zone, and the POD (a one-page PDF) when the consignee has signed.
CREATE TABLE portal_loads (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id                 uuid NOT NULL,
  reference               text NOT NULL CHECK (reference ~ '^FFE-[0-9]{6}$'),
  shipper_name            text NOT NULL CHECK (length(shipper_name) BETWEEN 1 AND 120),
  consignee_name          text NOT NULL CHECK (length(consignee_name) BETWEEN 1 AND 120),
  consignee_city          text NOT NULL CHECK (length(consignee_city) BETWEEN 1 AND 80),
  consignee_state         char(2) NOT NULL CHECK (consignee_state ~ '^[A-Z]{2}$'),
  scheduled_from          timestamptz NOT NULL,
  scheduled_to            timestamptz NOT NULL,
  delivery_checked_in_at  timestamptz,
  delivery_checked_out_at timestamptz,
  facility_time_zone      text NOT NULL CHECK (facility_time_zone IN ('America/New_York',
                            'America/Chicago', 'America/Denver', 'America/Los_Angeles',
                            'America/Phoenix')),
  pod_status              text NOT NULL CHECK (pod_status IN ('available', 'pending')),
  pod_signed_by           text CHECK (pod_signed_by IS NULL OR length(pod_signed_by) BETWEEN 1 AND 80),
  pod_signed_at           timestamptz,
  pod_pdf                 bytea,
  pod_byte_length         integer CHECK (pod_byte_length BETWEEN 1 AND 100000),
  pod_content_hash        text CHECK (pod_content_hash IS NULL OR pod_content_hash ~ '^[0-9a-f]{64}$'),
  notes                   text CHECK (notes IS NULL OR length(notes) <= 1000),
  seed_key                text CHECK (seed_key IS NULL OR seed_key ~ '^[a-z0-9-]{3,80}$'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_to >= scheduled_from),
  CHECK ((delivery_checked_in_at IS NULL) = (delivery_checked_out_at IS NULL)),
  CHECK (delivery_checked_out_at >= delivery_checked_in_at),
  CHECK ((pod_status = 'available') = (pod_pdf IS NOT NULL)
     AND (pod_pdf IS NULL) = (pod_byte_length IS NULL)
     AND (pod_pdf IS NULL) = (pod_content_hash IS NULL)
     AND (pod_pdf IS NULL) = (pod_signed_by IS NULL)
     AND (pod_pdf IS NULL) = (pod_signed_at IS NULL)),
  CHECK (pod_pdf IS NULL OR octet_length(pod_pdf) = pod_byte_length),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, load_id),
  UNIQUE (tenant_id, seed_key),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
ALTER TABLE portal_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_loads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_loads
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One run of the runner on one load. At most one live run per load (the partial unique index):
-- asking twice while one is queued, running or waiting for a person finds the same run.
CREATE TABLE portal_runs (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id          uuid NOT NULL,
  reference        text NOT NULL CHECK (reference ~ '^FFE-[0-9]{6}$'),
  requested_by     text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
  turn_id          uuid,
  trace_id         text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 64),
  model            text NOT NULL CHECK (model IN ('wonder', 'spark')),
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval',
                     'done', 'failed', 'declined', 'stopped')),
  ended_reason     text CHECK (ended_reason IS NULL OR ended_reason ~ '^[a-z_]{2,40}$'),
  step_count       integer NOT NULL DEFAULT 0 CHECK (step_count BETWEEN 0 AND 100),
  model_call_count integer NOT NULL DEFAULT 0 CHECK (model_call_count BETWEEN 0 AND 100),
  cost_nanocents   bigint NOT NULL DEFAULT 0 CHECK (cost_nanocents >= 0),
  last_url         text CHECK (last_url IS NULL OR length(last_url) <= 500),
  session_id       uuid,
  claim_token      uuid,
  claimed_at       timestamptz,
  resume_step      integer CHECK (resume_step IS NULL OR resume_step >= 0),
  started_at       timestamptz,
  finished_at      timestamptz,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('done', 'failed', 'declined', 'stopped')) = (finished_at IS NOT NULL)),
  CHECK ((status IN ('done', 'failed', 'declined', 'stopped')) = (ended_reason IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
CREATE UNIQUE INDEX portal_runs_live_idx ON portal_runs (tenant_id, load_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX portal_runs_tenant_load_created_idx ON portal_runs (tenant_id, load_id, created_at DESC);
CREATE INDEX portal_runs_tenant_created_idx ON portal_runs (tenant_id, created_at DESC);
ALTER TABLE portal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_runs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A one-time access code for the portal (stored as its sha256), minted for a run or for a person
-- who opens the portal themselves. It signs in once within 20 minutes; the session then lives
-- 60 minutes.
CREATE TABLE portal_sessions (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id             uuid,
  code_hash          text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz NOT NULL,
  signed_in_at       timestamptz,
  session_expires_at timestamptz,
  created_by         text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((signed_in_at IS NULL) = (session_expires_at IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES portal_runs (tenant_id, id)
);
CREATE INDEX portal_sessions_tenant_code_idx ON portal_sessions (tenant_id, code_hash);
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_sessions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE portal_runs ADD FOREIGN KEY (tenant_id, session_id)
  REFERENCES portal_sessions (tenant_id, id);

-- One step of a run. Seq 0 is the portal as first opened (no model call). Every later step is
-- one model call: the call as received (kept to send back on the next call), a summary of its
-- actions that never holds typed text, whether they ran, and the screenshot taken after them. A
-- step paused on a safety check has no screenshot until a person approves and its actions run
-- (the screen the model saw is the step before it). The last step of a finished run is the
-- model's answer: no call item, no actions, no screenshot.
CREATE TABLE portal_run_steps (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id              uuid NOT NULL,
  seq                 integer NOT NULL CHECK (seq BETWEEN 0 AND 100),
  model_call_id       uuid,
  upstream_call_id    text CHECK (upstream_call_id IS NULL OR length(upstream_call_id) <= 200),
  call_item           jsonb,
  action_summary      jsonb NOT NULL DEFAULT '[]',
  executed            boolean NOT NULL,
  stopped_early       boolean NOT NULL DEFAULT false,
  screenshot_mime     text CHECK (screenshot_mime IN ('image/png', 'image/jpeg')),
  screenshot          bytea,
  screenshot_bytes    integer CHECK (screenshot_bytes BETWEEN 1 AND 400000),
  url_after           text CHECK (url_after IS NULL OR length(url_after) <= 500),
  cost_nanocents      bigint NOT NULL DEFAULT 0 CHECK (cost_nanocents >= 0),
  pending_check_count integer NOT NULL DEFAULT 0 CHECK (pending_check_count BETWEEN 0 AND 8),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((screenshot IS NULL) = (screenshot_bytes IS NULL)
     AND (screenshot IS NULL) = (screenshot_mime IS NULL)),
  CHECK (screenshot IS NULL OR octet_length(screenshot) = screenshot_bytes),
  CHECK (NOT executed OR screenshot IS NOT NULL),
  CHECK ((call_item IS NULL) = (upstream_call_id IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES portal_runs (tenant_id, id)
);
ALTER TABLE portal_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_run_steps
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A safety check the platform raised on a step. Only a person sets approved; the next call
-- acknowledges exactly the approved checks of the step it resumes.
CREATE TABLE portal_run_checks (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL,
  step_id    uuid NOT NULL,
  check_id   text NOT NULL CHECK (length(check_id) BETWEEN 1 AND 200),
  code       text NOT NULL CHECK (code ~ '^[a-z_]{2,60}$'),
  message    text NOT NULL CHECK (length(message) <= 500),
  status     text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  decided_by text CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 200),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id, check_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES portal_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, step_id) REFERENCES portal_run_steps (tenant_id, id)
);
ALTER TABLE portal_run_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_run_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_run_checks
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- What one finished run found: the two stamps in the facility's zone, the POD the browser
-- captured, the screening of the model's answer, and whether it agrees with the portal's own
-- record (shown as a check, never used as the value). One row per run.
CREATE TABLE portal_evidence (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id                  uuid NOT NULL,
  load_id                 uuid NOT NULL,
  delivery_checked_in_at  timestamptz,
  delivery_checked_out_at timestamptz,
  facility_time_zone      text CHECK (facility_time_zone IS NULL OR facility_time_zone IN
                            ('America/New_York', 'America/Chicago', 'America/Denver',
                             'America/Los_Angeles', 'America/Phoenix')),
  times_step_seq          integer CHECK (times_step_seq IS NULL OR times_step_seq >= 0),
  pod_pdf                 bytea,
  pod_byte_length         integer CHECK (pod_byte_length BETWEEN 1 AND 300000),
  pod_content_hash        text CHECK (pod_content_hash IS NULL OR pod_content_hash ~ '^[0-9a-f]{64}$'),
  pod_step_seq            integer CHECK (pod_step_seq IS NULL OR pod_step_seq >= 0),
  answer                  jsonb NOT NULL,
  untrusted_input_id      uuid,
  screen_verdict          text NOT NULL CHECK (screen_verdict IN ('clean', 'flagged', 'error')),
  readback_match          text NOT NULL CHECK (readback_match IN ('matches', 'differs', 'partial')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((delivery_checked_in_at IS NULL) = (delivery_checked_out_at IS NULL)),
  CHECK ((delivery_checked_in_at IS NULL) = (facility_time_zone IS NULL)),
  CHECK (delivery_checked_out_at >= delivery_checked_in_at),
  CHECK ((pod_pdf IS NULL) = (pod_byte_length IS NULL)
     AND (pod_pdf IS NULL) = (pod_content_hash IS NULL)),
  CHECK (pod_pdf IS NULL OR octet_length(pod_pdf) = pod_byte_length),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES portal_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, untrusted_input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (untrusted_input_id)
);
CREATE INDEX portal_evidence_tenant_load_idx ON portal_evidence (tenant_id, load_id, created_at DESC);
ALTER TABLE portal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_evidence
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The model's answer is outside text like an email: it is stored and screened before anyone
-- relies on it. Both lists restate every value main allows and add the runner's.
ALTER TABLE untrusted_inputs DROP CONSTRAINT untrusted_inputs_kind_check;
ALTER TABLE untrusted_inputs ADD CONSTRAINT untrusted_inputs_kind_check
  CHECK (kind IN ('email', 'transcript', 'document', 'portal'));
ALTER TABLE untrusted_inputs DROP CONSTRAINT untrusted_inputs_source_check;
ALTER TABLE untrusted_inputs ADD CONSTRAINT untrusted_inputs_source_check
  CHECK (source IN ('inbound', 'upload', 'voice', 'seed_benign', 'seed_injection', 'portal_run'));

-- The portal's pages read accounts and loads and sign a session in; the runner and the routes
-- write runs, steps, checks and evidence. Named columns only for every UPDATE. The seed writes
-- accounts and loads with the admin login, which also clears every portal table.
GRANT SELECT ON portal_accounts, portal_loads TO payday_app;
GRANT SELECT, INSERT ON portal_sessions, portal_runs, portal_run_steps, portal_run_checks,
  portal_evidence TO payday_app;
GRANT UPDATE (signed_in_at, session_expires_at) ON portal_sessions TO payday_app;
GRANT UPDATE (failed_sign_ins, failed_window_start) ON portal_accounts TO payday_app;
GRANT UPDATE (status, ended_reason, step_count, model_call_count, cost_nanocents, last_url,
  session_id, claim_token, claimed_at, resume_step, started_at, finished_at, result)
  ON portal_runs TO payday_app;
GRANT UPDATE (executed, stopped_early, screenshot_mime, screenshot, screenshot_bytes, url_after)
  ON portal_run_steps TO payday_app;
GRANT UPDATE (status, decided_by, decided_at) ON portal_run_checks TO payday_app;
