-- Proposals the rules engine makes outside a chat turn: the invoice queue now, the weekly pay run
-- next. origin says which. An agent proposal keeps its conversation, turn, gateway decision and
-- trace exactly as before; an engine proposal has none of them, because no model and no turn made
-- it. One approve route, one gate, one auditor and one clean filter serve both.
--
-- No new table and no new grant: an engine proposal is inserted and moved by the same app grants
-- 0009 gave (INSERT, and UPDATE of status, decision and money columns), and row-level security on
-- proposals is unchanged (enabled, forced, one tenant_isolation policy).

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

-- The kinds, as the union of every design on the board (0009, DOC-VISION's load_rate_fill, this
-- file's invoice_post and payment_reapply, and the pay run's settlement_approve). Whichever
-- migration applies last carries this same list; proposals-kinds.db.test.ts inserts one row per
-- PROPOSAL_KINDS entry on a fresh database.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill',
  'invoice_post', 'payment_reapply', 'settlement_approve'));

-- The invoice page lists the engine's live cards per tenant.
CREATE INDEX proposals_tenant_origin_status ON proposals (tenant_id, origin, status);
