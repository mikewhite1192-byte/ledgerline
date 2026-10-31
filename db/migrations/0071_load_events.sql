-- LOAD-MOVEMENT (0071): a load moves from planned to in transit and from in transit to delivered
-- once its paperwork is read in, a driver's text or voice note says so with the whole load number,
-- or a person marks it. Code decides every move (src/lib/loads/movement.ts); no model writes a
-- status, and nothing here moves money.
--
-- 1. load_events: one row per move, written in the same transaction as the status it records.
--    from_status and to_status are the load's statuses on either side of the move. source says
--    who moved it: the paperwork a driver photographed (driver_photo), a driver's text
--    (driver_text) or voice note (driver_voice), a person's button (staff), Settings > Demo's
--    stand-in for a dispatch feed (demo_feed), or the seed's history (seed). evidence_table and
--    evidence_id name the document or message that moved it, both or neither. One move per piece
--    of evidence and status (load_events_one_per_evidence), so the same document read twice
--    records one move. The load is referenced on (tenant_id, id), so no row can name another
--    carrier's load, and a row goes with its load (the seed's replace and the demo reset delete
--    loads, so the events go with them). The app role may add a row and delete one (the seed's
--    replace runs as the app role); it may never change one.
-- 2. desk_log's source check, re-created as the full union of 0065's sources plus 'autopilot'
--    (0070, the autopilot's own source, which merges ahead of this file) plus the two new sources:
--    'document' (a read document matched to a load) and 'load_event' (a load_events row). Added
--    NOT VALID; 0071_load_events_validate.sql validates it. Any later migration that re-creates
--    it carries this list whole.
-- 3. proposals_kind_check, the full union of 0069's seventeen kinds, in the same order, plus
--    load_move (a card a person taps when a move could not be decided: no money, amount 0).
--    Added NOT VALID; 0071_load_events_validate.sql validates it.
-- 4. An index for the desk loop's document finder (read documents by their last change).
-- demo_reset_clear() is not re-created: load_events is a seeded table (src/lib/data/tables.ts),
-- emptied by the seed's replace through the loads it names.

-- 1. The moves.
CREATE TABLE load_events (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  load_id        uuid NOT NULL,
  from_status    text NOT NULL CHECK (from_status IN ('planned', 'in_transit')),
  to_status      text NOT NULL CHECK (to_status IN ('in_transit', 'delivered')),
  source         text NOT NULL
                   CHECK (source IN ('driver_photo', 'driver_text', 'driver_voice', 'staff', 'demo_feed', 'seed')),
  evidence_table text CHECK (evidence_table IN ('documents', 'inbound_messages', 'voice_notes')),
  evidence_id    uuid,
  -- When the move happened: the stop time read, the message time, or the press.
  at             timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT load_events_one_step CHECK (
    (from_status = 'planned' AND to_status = 'in_transit') OR
    (from_status = 'in_transit' AND to_status = 'delivered')),
  CONSTRAINT load_events_evidence_pair CHECK ((evidence_table IS NULL) = (evidence_id IS NULL)),
  -- A driver's evidence always names its row; a person's press and the demo feed never do.
  -- IS NOT DISTINCT FROM, never =: a NULL evidence_table must fail the check, not pass it.
  CONSTRAINT load_events_evidence_source CHECK (
    (source = 'driver_photo' AND evidence_table IS NOT DISTINCT FROM 'documents') OR
    (source = 'driver_text' AND evidence_table IS NOT DISTINCT FROM 'inbound_messages') OR
    (source = 'driver_voice' AND evidence_table IS NOT DISTINCT FROM 'voice_notes') OR
    (source IN ('staff', 'demo_feed', 'seed') AND evidence_table IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX load_events_one_per_evidence ON load_events (tenant_id, evidence_table, evidence_id, to_status)
  WHERE evidence_id IS NOT NULL;
CREATE INDEX load_events_tenant_load ON load_events (tenant_id, load_id, at);
CREATE INDEX load_events_tenant_created ON load_events (tenant_id, created_at);

ALTER TABLE load_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON load_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No UPDATE: a move that happened never changes.
GRANT SELECT, INSERT, DELETE ON load_events TO payday_app;

-- 2. The desk log's sources, full union, NOT VALID (validated in 0071_load_events_validate.sql).
ALTER TABLE desk_log DROP CONSTRAINT desk_log_source_check;
ALTER TABLE desk_log ADD CONSTRAINT desk_log_source_check CHECK (source IN (
  'card_transaction', 'inbound_message', 'voice_note', 'customer_payment', 'audit', 'sweep',
  'collections', 'cash_check', 'autopilot', 'document', 'load_event')) NOT VALID;

-- 3. The kind check, eighteen kinds, NOT VALID (validated in 0071_load_events_validate.sql).
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code', 'pay_policy_setup',
  'load_create', 'escrow_release', 'load_move')) NOT VALID;

-- 4. The desk loop's document finder.
CREATE INDEX documents_tenant_read_updated ON documents (tenant_id, updated_at)
  WHERE read_status = 'read';
