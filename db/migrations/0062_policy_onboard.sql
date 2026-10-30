-- POLICY-ONBOARD: set up a carrier's pay rules from its driver pay policy document. Additive only:
-- no new table, no new column, no grant change. Every table the run writes (documents,
-- untrusted_inputs, conversations, turns, turn_steps, proposals, pay_configs, pay_rule_changes)
-- already has forced row-level security, the tenant policy and the app role's grants, and
-- demo_reset_clear() already clears each of them, so it is not re-created.
--
-- 1. documents_document_kind_check: a stored pay policy is kind 'pay_policy'. The model's receipt
--    read never answers it (its schema lists the six receipt kinds only); only the policy upload
--    stores it. 0013 declares the check inline, so Postgres named it documents_document_kind_check.
ALTER TABLE documents DROP CONSTRAINT documents_document_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_document_kind_check CHECK (
  document_kind IS NULL OR document_kind IN ('lumper_receipt', 'toll_receipt', 'fuel_receipt',
    'rate_confirmation', 'bill_of_lading', 'other', 'pay_policy'));

-- 2. proposals_kind_check, the full union of every proposal kind on main (0048's fourteen, in the
--    same order) plus pay_policy_setup. Whichever re-creation runs last decides the check, so any
--    later one must list all fifteen.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change', 'card_match', 'money_code', 'pay_policy_setup'));

-- 3. pay_rule_changes: one row per rule a proposal changed. A pay rule change (0030) still writes
--    exactly one; a policy setup writes one per rule that differs from the version it starts
--    from, so the one-row-per-proposal key becomes one row per proposal and rule.
ALTER TABLE pay_rule_changes DROP CONSTRAINT pay_rule_changes_tenant_id_proposal_id_key;
ALTER TABLE pay_rule_changes ADD CONSTRAINT pay_rule_changes_tenant_id_proposal_id_rule_key_key
  UNIQUE (tenant_id, proposal_id, rule_key);
