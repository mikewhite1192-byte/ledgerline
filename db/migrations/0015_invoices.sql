-- Proposals the rules engine makes outside a chat turn: the invoice queue now, the weekly pay run
-- next. origin says which. An agent proposal keeps its conversation, turn, gateway decision and
-- trace exactly as before; an engine proposal has none of them, because no model and no turn made
-- it. One approve route, one gate, one auditor and one clean filter serve both.
--
-- No new table: an engine proposal is inserted and moved by the same app grants 0009 gave (INSERT,
-- and UPDATE of status, decision and money columns), and row-level security on proposals is
-- unchanged (enabled, forced, one tenant_isolation policy). The one new grant is USAGE on the
-- sequence behind each tenant's document key (below), so a tenant row the app inserts gets its key.

ALTER TABLE proposals
  ADD COLUMN origin text NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'engine')),
  ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN turn_id DROP NOT NULL,
  ALTER COLUMN gateway_decision_id DROP NOT NULL,
  ALTER COLUMN trace_id DROP NOT NULL,
  -- An agent proposal has all three of its turn links and an engine proposal has none.
  ADD CONSTRAINT proposals_origin_turn_check CHECK (
    (origin = 'agent') = (conversation_id IS NOT NULL AND turn_id IS NOT NULL
                          AND gateway_decision_id IS NOT NULL)
    AND (origin = 'agent' OR (conversation_id IS NULL AND turn_id IS NULL
                              AND gateway_decision_id IS NULL))),
  -- The trace stays required for every agent proposal.
  ADD CONSTRAINT proposals_origin_trace_check CHECK (origin = 'engine' OR trace_id IS NOT NULL);

-- The kinds, as the full union of every kind known on any branch: 0009's three, DOC-VISION's
-- load_rate_fill, this file's invoice_post and payment_reapply, the pay run's settlement_approve
-- and DETENTION's detention_charge. A kind with no code yet is harmless in a whitelist. 0013 and
-- 0022 re-create this check with the same full list, so production's merge order and a fresh
-- database's number order end with the same check; a later migration that adds a kind re-lists
-- them all. proposals-kinds.db.test.ts inserts one row per kind on a fresh database.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post', 'payment_reapply', 'settlement_approve', 'detention_charge'));

-- The invoice page lists the engine's live cards per tenant.
CREATE INDEX proposals_tenant_origin_status ON proposals (tenant_id, origin, status);

-- Each tenant's document key: T and four uppercase hex digits, unique across the database. An
-- invoice number and a customer payment reference carry it (T0001-PW10001), so two tenants posting
-- to one sandbox company never send the same number, even when their ids start alike. Existing
-- tenants get theirs in the order they were made; a new tenant takes the next one. The sequence
-- stops at FFFF rather than wrap, so a key is never handed out twice.
CREATE SEQUENCE tenant_doc_key_seq AS integer MINVALUE 1 MAXVALUE 65535 NO CYCLE;
ALTER TABLE tenants ADD COLUMN doc_key text;
-- The admin owns tenants. FORCE is lifted for this one transaction so the backfill sees every
-- tenant where the admin is a plain owner, and it is put back before the transaction ends.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
UPDATE tenants t SET doc_key = 'T' || upper(lpad(to_hex(n.rn::integer), 4, '0'))
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM tenants) n
 WHERE n.id = t.id;
SELECT setval('tenant_doc_key_seq', GREATEST((SELECT count(*) FROM tenants), 1),
              (SELECT count(*) FROM tenants) > 0);
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants
  ALTER COLUMN doc_key SET DEFAULT ('T' || upper(lpad(to_hex(nextval('tenant_doc_key_seq')::integer), 4, '0'))),
  ALTER COLUMN doc_key SET NOT NULL,
  ADD CONSTRAINT tenants_doc_key_format CHECK (doc_key ~ '^T[0-9A-F]{4}$'),
  ADD CONSTRAINT tenants_doc_key_unique UNIQUE (doc_key);
ALTER SEQUENCE tenant_doc_key_seq OWNED BY tenants.doc_key;
GRANT USAGE ON SEQUENCE tenant_doc_key_seq TO payday_app;
