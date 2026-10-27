-- Uploaded paperwork (receipts, rate confirmations, bills of lading) and the fourth proposal kind.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. A reference to another
-- tenant table is a composite foreign key on (tenant_id, x_id).
--
-- Grants are narrower than the README's default. The app may insert a document and finish its
-- read (the columns listed below), never change the file and never delete it: a document is
-- evidence. The seed never writes this table; a reseed clears it as the admin role, by tenant,
-- before it clears the seeded tables.

-- One uploaded file per row, bytes in the database (the Data API returns at most about 1 MiB, so
-- 700,000 raw bytes is the cap). reading is what Muse Spark returned: every number in it is a
-- claim, never a fact. match is the comparison with the records that code made from it.
-- untrusted_input_id points at the transcription the gateway screens; it goes back to null if
-- that row is deleted (a reseed clears documents first, so this never fires in practice).
-- content_hash is the sha256 hex of the file: the same file twice is one row, read once.
CREATE TABLE documents (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uploaded_by        text NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 128),
  filename           text NOT NULL CHECK (filename ~ '^[A-Za-z0-9._ -]{1,120}$'),
  mime               text NOT NULL
                       CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_length        integer NOT NULL CHECK (byte_length BETWEEN 1 AND 700000),
  bytes              bytea NOT NULL CHECK (octet_length(bytes) = byte_length),
  content_hash       text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  page_count         integer NOT NULL DEFAULT 1 CHECK (page_count BETWEEN 1 AND 3),
  read_status        text NOT NULL DEFAULT 'pending'
                       CHECK (read_status IN ('pending', 'read', 'unreadable', 'budget')),
  document_kind      text CHECK (document_kind IN ('lumper_receipt', 'toll_receipt', 'fuel_receipt',
                       'rate_confirmation', 'bill_of_lading', 'other')),
  reading            jsonb CHECK (reading IS NULL OR jsonb_typeof(reading) = 'object'),
  match              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(match) = 'object'),
  untrusted_input_id uuid,
  read_call_id       uuid,
  trace_id           uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (read_status = 'read' OR reading IS NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_hash),
  FOREIGN KEY (tenant_id, untrusted_input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (untrusted_input_id)
);
CREATE INDEX documents_tenant_created ON documents (tenant_id, created_at DESC);
CREATE UNIQUE INDEX documents_tenant_input ON documents (tenant_id, untrusted_input_id)
  WHERE untrusted_input_id IS NOT NULL;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON documents TO payday_app;
GRANT UPDATE (read_status, document_kind, reading, match, untrusted_input_id, read_call_id,
              updated_at) ON documents TO payday_app;

-- The fourth proposal kind: fill a load's missing rate from its rate confirmation. No money
-- moves; the executor writes the load's rate once, only while it is still empty.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill'));
