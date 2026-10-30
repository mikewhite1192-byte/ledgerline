-- The phone line: a dispatcher's call with a driver, sent by the office's browser as short
-- segments (about 30 seconds of 16 kHz mono audio each, a POST per segment). Each segment is
-- transcribed with its turns split at pauses, screened, and read by one model call into a case
-- update per turn. The first advance request or pay question in a segment becomes an ordinary
-- voice note (0012) handed to the agent, which reads and proposes; a person approves on the card.
-- The audio itself is never stored: the turns' text is the record.
--
--   calls          one call: its driver, its trace (every model call on it shares one), how many
--                  segments it took and how many turns it handed off, and when it ended
--   call_segments  one segment of a call: where it is in the steps, why it stopped (a category,
--                  never upstream text), how many tries it took (at most 3), where it sits in the
--                  call, and the ids of its transcript (an untrusted input, 0008) and model calls
--   call_turns     one turn of a segment: its words, where it sits in the call, the case update
--                  read from it, and the voice note and conversation a handed-off turn became
--
-- Dedupe: (tenant_id, call_id, seq) holds one row per segment, so a re-sent segment reads its row
-- instead of being transcribed again; (tenant_id, segment_id, turn_key) holds one row per turn; and
-- voice_notes' (tenant_id, input_id) index holds one note per segment's transcript, so a retry can
-- never hand a segment off twice.
--
-- Every table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app (a call's id by the
-- office's browser). Every reference to another tenant table is a composite foreign key on
-- (tenant_id, x_id). The voice note and conversation a turn names are plain ids, like money_codes'
-- (0048): the demo reset clears both, and a turn keeps its words without them.
--
-- Grants: SELECT and INSERT, and UPDATE on each table's own moving columns only. A call's driver,
-- trace and tenant, a segment's call and place, and a turn's segment and words are fixed once
-- written. The app role has no DELETE on any of them. The seed's replace and the demo reset clear
-- them through the driver: a call names its driver with ON DELETE CASCADE, so deleting the
-- carrier's drivers takes its calls, their segments and their turns along (the referential action
-- runs as the table owner, as the arming log's does in 0027); the seed's admin login also deletes
-- them before the replace. Removing a transcript's input clears only the segment's input_id (no
-- check names it). Not in demo_reset_clear().

CREATE TABLE calls (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL,
  trace_id        uuid NOT NULL,
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  status          text NOT NULL CHECK (status IN ('open', 'ended')),
  segments        integer NOT NULL DEFAULT 0 CHECK (segments BETWEEN 0 AND 1000),
  hand_offs       integer NOT NULL DEFAULT 0 CHECK (hand_offs BETWEEN 0 AND 100),
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_segment_at timestamptz,
  ended_at        timestamptz,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX calls_tenant_started ON calls (tenant_id, started_at DESC);
CREATE INDEX calls_tenant_driver ON calls (tenant_id, driver_id);

CREATE TABLE call_segments (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id            uuid NOT NULL,
  seq                integer NOT NULL CHECK (seq BETWEEN 0 AND 999),
  status             text NOT NULL CHECK (status IN
                       ('received', 'transcribed', 'blocked', 'done', 'empty', 'failed')),
  fail_category      text CHECK (fail_category ~ '^[a-z_]{2,40}$'),
  attempts           smallint NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  offset_ms          integer NOT NULL CHECK (offset_ms BETWEEN 0 AND 3600000),
  duration_ms        integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 30000),
  input_id           uuid,
  transcript_call_id uuid,
  update_call_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A stopped segment says why, as a category; one still moving or finished has none.
  CHECK ((status = 'failed') = (fail_category IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, call_id, seq),
  FOREIGN KEY (tenant_id, call_id) REFERENCES calls (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (input_id)
);
CREATE INDEX call_segments_tenant_input ON call_segments (tenant_id, input_id) WHERE input_id IS NOT NULL;

CREATE TABLE call_turns (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id       uuid NOT NULL,
  turn_key         text NOT NULL CHECK (turn_key ~ '^[0-9]{1,3}:[0-9]{1,3}$'),
  upstream_turn_id text CHECK (upstream_turn_id IS NULL OR length(upstream_turn_id) BETWEEN 1 AND 64),
  start_ms         integer NOT NULL CHECK (start_ms BETWEEN 0 AND 3630000),
  end_ms           integer NOT NULL CHECK (end_ms > start_ms AND end_ms <= 3630000),
  text             text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  update_kind      text CHECK (update_kind IN
                     ('advance_request', 'pay_question', 'dispute', 'promise', 'note', 'none')),
  english_text     text CHECK (char_length(english_text) <= 600),
  amount_cents     bigint CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 100000000),
  summary          text CHECK (char_length(summary) <= 200),
  voice_note_id    uuid,
  conversation_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, segment_id, turn_key),
  FOREIGN KEY (tenant_id, segment_id) REFERENCES call_segments (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calls
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON calls TO payday_app;
GRANT UPDATE (status, segments, hand_offs, last_segment_at, ended_at) ON calls TO payday_app;

ALTER TABLE call_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_segments
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON call_segments TO payday_app;
GRANT UPDATE (status, fail_category, attempts, input_id, transcript_call_id, update_call_id, updated_at)
  ON call_segments TO payday_app;

ALTER TABLE call_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_turns
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON call_turns TO payday_app;
GRANT UPDATE (update_kind, english_text, amount_cents, summary, voice_note_id, conversation_id)
  ON call_turns TO payday_app;
