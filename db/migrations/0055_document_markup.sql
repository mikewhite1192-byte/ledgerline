-- A marked copy of an uploaded document photo: the image model circles the printed line in
-- question and writes what the records say beside it, then a second read checks the copy. The
-- copy never replaces the file and never feeds a number; one that fails the check is not kept.
--
-- Columns only, so the documents table keeps its row-level security, FORCE, policy and narrow
-- grants from 0013, and a reseed or demo reset that deletes documents takes the copies with them.
--
-- markup_status: none (never tried), marking (a try is running), checked (kept; the only state
-- with bytes), mismatch (the copy did not read back the same numbers; not kept), unavailable (no
-- copy this time: budget, a timeout or an error). markup_attempts counts tries started, at most
-- three; a budget refusal gives its try back. markup_category is a fixed word, never upstream
-- text. The copy is at most 700,000 bytes, the same cap as an upload: a statement reads either
-- bytes or markup_bytes, never both, so one answer stays under the Data API's 1 MiB limit.
ALTER TABLE documents
  ADD COLUMN markup_status   text NOT NULL DEFAULT 'none'
    CHECK (markup_status IN ('none', 'marking', 'checked', 'mismatch', 'unavailable')),
  ADD COLUMN markup_attempts smallint NOT NULL DEFAULT 0 CHECK (markup_attempts BETWEEN 0 AND 3),
  ADD COLUMN markup_target   text CHECK (markup_target ~ '^[a-z_]{3,40}$'),
  ADD COLUMN markup_callout  text CHECK (length(markup_callout) <= 120),
  ADD COLUMN markup_category text CHECK (markup_category IN
    ('field_changed', 'callout_wrong', 'anchor_wrong', 'extra_amount', 'off_schema', 'no_anchor_line',
     'too_large', 'timeout', 'budget', 'unknown')),
  ADD COLUMN markup_mime     text CHECK (markup_mime IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD COLUMN markup_length   integer CHECK (markup_length BETWEEN 1 AND 700000),
  ADD COLUMN markup_bytes    bytea CHECK (markup_bytes IS NULL OR octet_length(markup_bytes) = markup_length),
  ADD COLUMN markup_hash     text CHECK (markup_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN markup_check    jsonb,
  ADD COLUMN markup_edit_call_id  uuid,
  ADD COLUMN markup_check_call_id uuid,
  ADD COLUMN markup_at       timestamptz,
  ADD CONSTRAINT documents_markup_bytes CHECK ((markup_status = 'checked') = (markup_bytes IS NOT NULL)),
  ADD CONSTRAINT documents_markup_file CHECK (
    (markup_bytes IS NULL) = (markup_mime IS NULL)
    AND (markup_bytes IS NULL) = (markup_length IS NULL)
    AND (markup_bytes IS NULL) = (markup_hash IS NULL));

GRANT UPDATE (markup_status, markup_attempts, markup_target, markup_callout, markup_category, markup_mime,
              markup_length, markup_bytes, markup_hash, markup_check, markup_edit_call_id,
              markup_check_call_id, markup_at) ON documents TO payday_app;
