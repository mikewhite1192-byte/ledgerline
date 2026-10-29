-- Carrier memory: short notes the office keeps about a customer, a driver or the carrier as a
-- whole, which the agent reads as context on each question (src/lib/memory/notes.ts). A note
-- never changes a number: the rules engine computes every amount, the notes are labeled context
-- only in the agent's summary, and their figures are never added to the set the answer check
-- allows. Everything is behind carrierMemoryEnabled (off): with the switch off nothing reads or
-- writes these rows.
--
-- A note is 1 to 300 characters of plain text on one line: no web address (https:// or a bare
-- www.) and no control characters, so a note cannot pose as a link or start a new line inside the
-- agent's summary. The text check refuses every text the app's rule refuses (noteTextSchema in
-- src/lib/memory/notes.ts) and accepts every text the app writes: both count characters as code
-- points, a text of nothing but spaces of any kind is refused, and every class is spelled out
-- rather than taken from the database's locale. So the page can show, and remove, every row the
-- table holds.
-- Status: suggested (written by the agent, seen by nobody yet) or active (written by a person, or
-- a suggestion a person kept). Only active notes reach the agent. Removing a note is a real
-- DELETE.
--
-- subject_id and the source columns are soft references on purpose: a subject is a customer or a
-- driver, and one column cannot carry two composite foreign keys; turns are cleared by
-- demo_reset_clear() before the seed's replace runs, so a hard key to turns would break the demo
-- reset. The app checks that the subject is a row of this carrier before it writes. The model
-- call that wrote a suggestion is a hard key: model_calls is kept by the reset.
--
-- carrier_notes is a seeded table (src/lib/data/tables.ts TENANT_TABLES): the seed's replace
-- deletes and rewrites it, so the demo reset needs no change to demo_reset_clear().
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security, the one tenant_isolation policy, UNIQUE (tenant_id, id) and composite keys.

CREATE TABLE carrier_notes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_kind             text NOT NULL CHECK (subject_kind IN ('customer', 'driver', 'carrier')),
  -- The customer or driver the note is about; null for the whole carrier.
  subject_id               uuid,
  text                     text NOT NULL CHECK (
                             char_length(text) BETWEEN 1 AND 300
                             AND text !~* 'https?://'
                             AND text !~ '(^|[^A-Za-z0-9_])[Ww][Ww][Ww]\.'
                             AND text !~ '[\u0001-\u001f\u007f-\u009f]'
                             AND text ~ '[^ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
                             AND text = btrim(text)
                           ),
  status                   text NOT NULL CHECK (status IN ('suggested', 'active')),
  source_kind              text NOT NULL CHECK (source_kind IN ('chat', 'record', 'person', 'seed')),
  -- The chat turn a suggestion came from.
  source_turn_id           uuid,
  -- The record a note was written from.
  source_table             text CHECK (source_table IN ('customers', 'drivers', 'loads', 'invoices',
                                                         'settlements', 'advances', 'customer_payments')),
  source_id                uuid,
  created_by_kind          text NOT NULL CHECK (created_by_kind IN ('person', 'agent', 'seed')),
  -- The signed-in person's subject, for a note a person wrote.
  created_by_sub           text,
  -- The model call that suggested it, for a note the agent wrote.
  created_by_model_call_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by_sub           text,
  UNIQUE (tenant_id, id),
  CHECK ((subject_kind = 'carrier') = (subject_id IS NULL)),
  CHECK ((source_table IS NULL) = (source_id IS NULL)),
  CHECK (created_by_kind <> 'person' OR created_by_sub IS NOT NULL),
  CHECK (created_by_kind <> 'agent' OR (source_turn_id IS NOT NULL AND created_by_model_call_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, created_by_model_call_id) REFERENCES model_calls (tenant_id, id)
);

CREATE INDEX carrier_notes_subject ON carrier_notes (tenant_id, subject_kind, subject_id, status, created_at DESC);

-- One note per subject and words: the same add sent twice writes one row (the app answers the
-- second with "already on file"). A whole-carrier note has no subject id, so the zero id stands in
-- for it here. Suggestions and kept notes share the key: the agent cannot suggest what the office
-- already keeps, and keeping a suggestion can never collide with a note already kept.
CREATE UNIQUE INDEX carrier_notes_one_text ON carrier_notes
  (tenant_id, subject_kind, COALESCE(subject_id, CAST('00000000-0000-0000-0000-000000000000' AS uuid)), text);

ALTER TABLE carrier_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE carrier_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON carrier_notes
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON carrier_notes TO payday_app;

-- Which notes each turn and each second check saw: ids only, since a note may be edited or
-- removed later. A turn writes its list when the turn row is inserted (turns has an INSERT
-- grant). The second check writes its list onto the proposal it read, so the app role gets an
-- UPDATE of that one column, next to the auditor columns it already updates.
ALTER TABLE turns ADD COLUMN notes_used jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(notes_used) = 'array');
ALTER TABLE proposals ADD COLUMN auditor_notes_used jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(auditor_notes_used) = 'array');
GRANT UPDATE (auditor_notes_used) ON proposals TO payday_app;
