-- A photo cropped to the paper before it is read: the segmenter finds the document in the photo
-- and the server warps its four corners flat (or cuts out its box), so the read sees the paper
-- rather than the cab. The crop never replaces the file, its content hash or what the read is for;
-- anything unsure reads the raw photo.
--
-- Columns only, so the documents table keeps its row-level security, FORCE, policy and narrow
-- grants from 0013, and a reseed or demo reset that deletes documents takes the crops with them.
--
-- crop_status: none (never tried), cropping (a try is running), cropped (kept; the only state with
-- bytes), skipped (a definite no; final), unavailable (no answer this time; Read again may try
-- once more). crop_attempts counts tries started, at most two. crop_category is a fixed word,
-- never upstream text, set exactly on skipped and unavailable. crop_quad and crop_box are pixels of
-- the normalized frame the segmenter saw; crop_confidence is in thousandths. The crop is at most
-- 700,000 bytes, the same cap as an upload: a statement reads one of bytes, markup_bytes and
-- crop_bytes, never two, so one answer stays under the Data API's 1 MiB limit.
ALTER TABLE documents
  ADD COLUMN crop_status     text NOT NULL DEFAULT 'none'
    CHECK (crop_status IN ('none', 'cropping', 'cropped', 'skipped', 'unavailable')),
  ADD COLUMN crop_attempts   smallint NOT NULL DEFAULT 0 CHECK (crop_attempts BETWEEN 0 AND 2),
  ADD COLUMN crop_method     text CHECK (crop_method IN ('quad', 'box')),
  ADD COLUMN crop_category   text CHECK (crop_category IN
    ('no_match', 'low_confidence', 'too_small', 'already_flat', 'size_mismatch', 'too_large',
     'bad_image', 'decode_error', 'timeout', 'unavailable', 'network', 'rate_limited', 'unknown',
     'budget', 'no_library', 'stalled')),
  ADD COLUMN crop_mime       text CHECK (crop_mime IN ('image/jpeg')),
  ADD COLUMN crop_length     integer CHECK (crop_length BETWEEN 1 AND 700000),
  ADD COLUMN crop_bytes      bytea CHECK (crop_bytes IS NULL OR octet_length(crop_bytes) = crop_length),
  ADD COLUMN crop_hash       text CHECK (crop_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN crop_quad       jsonb CHECK (crop_quad IS NULL OR jsonb_typeof(crop_quad) = 'array'),
  ADD COLUMN crop_box        jsonb CHECK (crop_box IS NULL OR jsonb_typeof(crop_box) = 'object'),
  ADD COLUMN crop_confidence smallint CHECK (crop_confidence BETWEEN 0 AND 1000),
  ADD COLUMN crop_call_id    uuid,
  ADD COLUMN crop_at         timestamptz,
  ADD CONSTRAINT documents_crop_bytes CHECK ((crop_status = 'cropped') = (crop_bytes IS NOT NULL)),
  ADD CONSTRAINT documents_crop_file CHECK (
    (crop_bytes IS NULL) = (crop_mime IS NULL)
    AND (crop_bytes IS NULL) = (crop_length IS NULL)
    AND (crop_bytes IS NULL) = (crop_hash IS NULL)
    AND (crop_bytes IS NULL) = (crop_method IS NULL)),
  ADD CONSTRAINT documents_crop_category CHECK (
    (crop_category IS NOT NULL) = (crop_status IN ('skipped', 'unavailable')));

GRANT UPDATE (crop_status, crop_attempts, crop_method, crop_category, crop_mime, crop_length,
              crop_bytes, crop_hash, crop_quad, crop_box, crop_confidence, crop_call_id, crop_at)
  ON documents TO payday_app;
