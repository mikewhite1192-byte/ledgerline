-- Dock clips: a short video of a stop, kept only after faces and plates are blurred. The upload
-- runs the two segmentation calls (faces, plates) on the raw file and keeps their boxes, the raw
-- file's hash, size and header facts; the raw bytes are never stored (there is no column for
-- them). The uploader's browser blurs the boxes and sends the redacted file, which is the only
-- video kept. The reading model reads the redacted file; its reading is printed values only, and
-- it never changes a stored time or a number.
--
-- Status: redacting (no redacted file yet) -> redacted (file kept) -> read | unreadable (the
-- reading failed its schema; a person reads the clip) | budget (the reading was refused by the
-- spend cap; it can be tried again). redacting and the redacted file's absence are the same fact.
--
-- The row is written before any model call (the reservation). Each segmentation answer is kept
-- the moment it lands, with its call id, so a retry runs only the concept still missing and a
-- paid answer is never asked for twice. The *_started_at columns are 90-second leases, so two
-- requests for the same clip make one call; the *_attempts columns stop a clip that keeps
-- failing at three tries.
--
-- Grants are narrower than the README's default: the app inserts a clip and finishes it, and
-- never deletes one (a redacted clip is evidence). Only the admin login's reseed clears them.
CREATE TABLE evidence_clips (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id              uuid NOT NULL,
  stop                 text NOT NULL CHECK (stop IN ('pickup', 'delivery')),
  -- The uploader's login subject, as documents and proposals record a person.
  uploaded_by          text NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 128),
  filename             text NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
  raw_hash             char(64) NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
  raw_byte_length      integer NOT NULL CHECK (raw_byte_length BETWEEN 1 AND 700000),
  width                integer NOT NULL CHECK (width BETWEEN 64 AND 1920),
  height               integer NOT NULL CHECK (height BETWEEN 64 AND 1920),
  frames_per_second    integer NOT NULL CHECK (frames_per_second BETWEEN 1 AND 30),
  frame_count          integer NOT NULL CHECK (frame_count BETWEEN 1 AND 600),
  duration_ms          integer NOT NULL CHECK (duration_ms BETWEEN 1000 AND 20000),
  status               text NOT NULL
                       CHECK (status IN ('redacting', 'redacted', 'read', 'unreadable', 'budget')),
  -- {"face": [[frame, x1, y1, x2, y2, confidence or null], ...], "plate": [...]} in the clip's
  -- pixels. Boxes only, never a pixel. A key is present exactly when its call's id is.
  redaction            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(redaction) = 'object'),
  face_call_id         uuid,
  plate_call_id        uuid,
  redact_attempts      smallint NOT NULL DEFAULT 0 CHECK (redact_attempts BETWEEN 0 AND 3),
  redact_started_at    timestamptz,
  redacted_bytes       bytea,
  redacted_hash        char(64) CHECK (redacted_hash ~ '^[0-9a-f]{64}$'),
  redacted_byte_length integer CHECK (redacted_byte_length BETWEEN 1 AND 700000),
  -- The reading's fields plus the agreement with the stored stop times.
  reading              jsonb CHECK (reading IS NULL OR jsonb_typeof(reading) = 'object'),
  read_call_id         uuid,
  read_attempts        smallint NOT NULL DEFAULT 0 CHECK (read_attempts BETWEEN 0 AND 3),
  read_started_at      timestamptz,
  trace_id             uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  redacted_at          timestamptz,
  read_at              timestamptz,
  CHECK ((face_call_id IS NULL) = (redaction -> 'face' IS NULL)),
  CHECK ((plate_call_id IS NULL) = (redaction -> 'plate' IS NULL)),
  CHECK (status = 'redacting' OR (face_call_id IS NOT NULL AND plate_call_id IS NOT NULL)),
  CHECK ((status = 'redacting') = (redacted_bytes IS NULL)),
  CHECK ((redacted_bytes IS NULL) = (redacted_hash IS NULL)),
  CHECK ((redacted_bytes IS NULL) = (redacted_byte_length IS NULL)),
  CHECK ((redacted_bytes IS NULL) = (redacted_at IS NULL)),
  CHECK (redacted_byte_length IS NULL OR redacted_byte_length = octet_length(redacted_bytes)),
  CHECK (redacted_hash IS NULL OR redacted_hash <> raw_hash),
  CHECK ((status IN ('read', 'unreadable')) = (read_call_id IS NOT NULL)),
  CHECK ((status = 'read') = (reading IS NOT NULL)),
  CHECK ((status IN ('read', 'unreadable')) = (read_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, raw_hash),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  -- Each call a clip names is a row of the same carrier's model ledger, on the (tenant_id, id)
  -- key 0019 added to model_calls, with no delete action, as driver_notes names its call. A call
  -- column stays null until its answer is kept, and a null skips the check (MATCH SIMPLE).
  FOREIGN KEY (tenant_id, face_call_id) REFERENCES model_calls (tenant_id, id),
  FOREIGN KEY (tenant_id, plate_call_id) REFERENCES model_calls (tenant_id, id),
  FOREIGN KEY (tenant_id, read_call_id) REFERENCES model_calls (tenant_id, id)
);
CREATE INDEX evidence_clips_load_idx ON evidence_clips (tenant_id, load_id, created_at DESC);
CREATE INDEX evidence_clips_created_idx ON evidence_clips (tenant_id, created_at);
ALTER TABLE evidence_clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_clips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON evidence_clips
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- A clip moves forward only: a segmentation answer, the redacted file and the reading never change
-- once kept, so a second upload cannot replace the evidence, and attempts never go down.
CREATE FUNCTION evidence_clips_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'redacting' AND NEW.status = 'redacted')
    OR (OLD.status IN ('redacted', 'budget') AND NEW.status IN ('read', 'unreadable', 'budget'))) THEN
    RAISE EXCEPTION 'evidence_clips: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.face_call_id IS NOT NULL AND (
       NEW.face_call_id IS DISTINCT FROM OLD.face_call_id
    OR NEW.redaction -> 'face' IS DISTINCT FROM OLD.redaction -> 'face') THEN
    RAISE EXCEPTION 'evidence_clips: a face answer never changes once kept'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.plate_call_id IS NOT NULL AND (
       NEW.plate_call_id IS DISTINCT FROM OLD.plate_call_id
    OR NEW.redaction -> 'plate' IS DISTINCT FROM OLD.redaction -> 'plate') THEN
    RAISE EXCEPTION 'evidence_clips: a plate answer never changes once kept'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.redact_attempts < OLD.redact_attempts OR NEW.read_attempts < OLD.read_attempts THEN
    RAISE EXCEPTION 'evidence_clips: attempts never go down' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.redacted_bytes IS NOT NULL AND (
       NEW.redacted_bytes IS DISTINCT FROM OLD.redacted_bytes
    OR NEW.redacted_hash IS DISTINCT FROM OLD.redacted_hash
    OR NEW.redacted_byte_length IS DISTINCT FROM OLD.redacted_byte_length
    OR NEW.redacted_at IS DISTINCT FROM OLD.redacted_at) THEN
    RAISE EXCEPTION 'evidence_clips: the redacted file never changes once kept'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_call_id IS NOT NULL AND (
       NEW.read_call_id IS DISTINCT FROM OLD.read_call_id
    OR NEW.reading IS DISTINCT FROM OLD.reading
    OR NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'evidence_clips: a reading never changes once kept'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER evidence_clips_guard BEFORE UPDATE ON evidence_clips
  FOR EACH ROW EXECUTE FUNCTION evidence_clips_guard();

GRANT SELECT, INSERT ON evidence_clips TO payday_app;
GRANT UPDATE (status, redaction, face_call_id, plate_call_id, redact_attempts, redact_started_at,
              redacted_bytes, redacted_hash, redacted_byte_length, redacted_at, reading,
              read_call_id, read_attempts, read_started_at, read_at, trace_id)
  ON evidence_clips TO payday_app;
