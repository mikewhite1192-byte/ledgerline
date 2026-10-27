-- The Inbox: one row per message a driver sent the carrier, pasted by the office or (later) emailed
-- to the carrier's inbound address, and where it is: received, held for a person (the safety screen
-- flagged it), sorted by the triage model, handed to the agent, or failed with a category. The
-- message text itself is an untrusted input (0008, kind 'email', source 'inbound'), so it is
-- screened like any other outside message before a model reads it.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app (a pasted message's id by
-- the page, so a repeated press is the same row). Every reference to another tenant table is a
-- composite foreign key on (tenant_id, x_id); removing the input, the driver, the screening or the
-- conversation clears only that column. No check ties conversation_id to handed_off: the demo
-- reset and the seed clear conversations and the key sets the column to null, and a check would
-- make that fail (voice_notes has the same shape for the same reason).
--
-- Dedupe: one row per email Message-ID per carrier, and one row per untrusted input, so the same
-- event processed twice is one row. Sorting tries are counted and capped at 3, the same number as
-- flags.inboxLimits.maxAttempts: raise both together.
--
-- Grants: SELECT and INSERT, and UPDATE on the pipeline's own columns only. Its channel, input,
-- sender, subject, Message-ID, trace and tenant are fixed once the row is written. There is no
-- DELETE grant: the demo reset function (SECURITY DEFINER) owns deletion. Money is integer cents.

CREATE TABLE inbound_messages (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('paste', 'email')),
  input_id            uuid,
  driver_id           uuid,
  from_address        text CHECK (from_address IS NULL OR length(from_address) <= 320),
  subject             text CHECK (subject IS NULL OR length(subject) <= 300),
  message_id          text CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 998),
  received_at         timestamptz NOT NULL,
  status              text NOT NULL CHECK (status IN
                        ('received', 'blocked', 'triaged', 'handed_off', 'failed')),
  fail_category       text CHECK (fail_category ~ '^[a-z_]{2,40}$'),
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  screening_id        uuid,
  triage_category     text CHECK (triage_category ~ '^[a-z_]{2,40}$'),
  triage_urgency      text CHECK (triage_urgency IN ('low', 'normal', 'high')),
  triage_amount_cents bigint CHECK (triage_amount_cents IS NULL
                        OR (triage_amount_cents >= 0 AND triage_amount_cents < 100000000)),
  triage_dates        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(triage_dates) = 'array'),
  triage_call_id      uuid,
  triage_target       text CHECK (triage_target IN ('spark', 'spark_open')),
  conversation_id     uuid,
  created_by          text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  trace_id            uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('failed', 'blocked')) = (fail_category IS NOT NULL)),
  CHECK (status NOT IN ('triaged', 'handed_off') OR triage_category IS NOT NULL),
  CHECK ((channel = 'email') = (message_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (input_id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
    ON DELETE SET NULL (driver_id),
  FOREIGN KEY (tenant_id, screening_id) REFERENCES screenings (tenant_id, id)
    ON DELETE SET NULL (screening_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE SET NULL (conversation_id)
);
CREATE UNIQUE INDEX inbound_messages_tenant_message_id_uq
  ON inbound_messages (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX inbound_messages_tenant_input_uq
  ON inbound_messages (tenant_id, input_id) WHERE input_id IS NOT NULL;
CREATE INDEX inbound_messages_tenant_received ON inbound_messages (tenant_id, received_at DESC);
ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_messages
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON inbound_messages TO payday_app;
GRANT UPDATE (status, fail_category, attempts, driver_id, screening_id, triage_category,
              triage_urgency, triage_amount_cents, triage_dates, triage_call_id, triage_target,
              conversation_id, updated_at) ON inbound_messages TO payday_app;
