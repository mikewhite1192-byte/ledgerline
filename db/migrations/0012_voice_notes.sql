-- A driver's voice note: the recording kept for playback, where it is in the pipeline (transcribed,
-- screened, translated, sorted, handed to the agent, replied), and the ids of the model calls that
-- worked on it. The transcript itself is an untrusted input (0008, kind 'transcript', source
-- 'voice'), so it is screened like any other outside message before a model reads it.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. Every reference to another
-- tenant table is a composite foreign key on (tenant_id, x_id); removing the driver, the input or
-- the conversation clears only that column.
--
-- Grants: SELECT, INSERT and DELETE, and UPDATE on the pipeline's own columns only. The recording
-- (audio, audio_mime, audio_bytes), its driver, its input, its trace and its tenant are fixed once
-- the row is written.
--
-- The recording is stored here (design D1), capped at 700,000 bytes so one row reads back under the
-- Data API's 1 MiB answer limit. The WAV sent to the model is not stored. Numbers are integers
-- (the Data API takes no floats): the language confidence is in thousandths.

CREATE TABLE voice_notes (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id                 uuid,
  input_id                  uuid,
  trace_id                  uuid NOT NULL,
  created_by                text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  status                    text NOT NULL CHECK (status IN
                              ('transcribed', 'blocked', 'ready', 'handed_off', 'replied', 'failed')),
  fail_category             text CHECK (fail_category ~ '^[a-z_]{2,40}$'),
  audio                     bytea,
  audio_mime                text CHECK (audio_mime IN
                              ('audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg')),
  audio_bytes               integer CHECK (audio_bytes BETWEEN 1 AND 700000),
  duration_ms               integer CHECK (duration_ms BETWEEN 1 AND 600000),
  transcript_call_id        uuid,
  language                  text CHECK (language IN ('en', 'es', 'other', 'unknown')),
  language_confidence_milli integer CHECK (language_confidence_milli BETWEEN 0 AND 1000),
  english_text              text CHECK (char_length(english_text) <= 6000),
  prepare_call_id           uuid,
  triage_category           text CHECK (triage_category ~ '^[a-z_]{2,40}$'),
  triage_urgency            text CHECK (triage_urgency IN ('low', 'normal', 'high')),
  triage_call_id            uuid,
  amount_cents              integer CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 100000000),
  conversation_id           uuid,
  reply_text                text CHECK (char_length(reply_text) BETWEEN 1 AND 1200),
  reply_call_id             uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- The recording, its type and its size come together, and the size is the stored length.
  CHECK ((audio IS NULL) = (audio_mime IS NULL) AND (audio IS NULL) = (audio_bytes IS NULL)),
  CHECK (audio IS NULL OR octet_length(audio) = audio_bytes),
  -- A stopped note says why, as a category; a note still moving has no category.
  CHECK ((status IN ('failed', 'blocked')) = (fail_category IS NOT NULL)),
  -- Past the safety screen and the translation, a note has its language and English text; a
  -- replied note has its reply. (No check names input_id: removing an input clears it.)
  CHECK (status NOT IN ('ready', 'handed_off', 'replied') OR (language IS NOT NULL AND english_text IS NOT NULL)),
  CHECK (status <> 'replied' OR reply_text IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
    ON DELETE SET NULL (driver_id),
  FOREIGN KEY (tenant_id, input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (input_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
    ON DELETE SET NULL (conversation_id)
);
CREATE INDEX voice_notes_tenant_created ON voice_notes (tenant_id, created_at DESC);
-- One note per transcript: the agent's read tool finds the note by its input.
CREATE UNIQUE INDEX voice_notes_tenant_input_uq ON voice_notes (tenant_id, input_id)
  WHERE input_id IS NOT NULL;

ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_notes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, DELETE ON voice_notes TO payday_app;
GRANT UPDATE (status, fail_category, language, language_confidence_milli, english_text,
              prepare_call_id, triage_category, triage_urgency, triage_call_id, amount_cents,
              conversation_id, reply_text, reply_call_id, updated_at)
  ON voice_notes TO payday_app;
