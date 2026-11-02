-- AUTOPILOT CHANGES (0089): the record of every change the owner makes to the autopilot from the
-- app: each save of a rule (src/lib/autopilot/rules-admin.ts) and each Pause or Resume
-- (src/lib/autopilot/state.ts), written in the same transaction as the change itself, so a change
-- with no record and a record with no change cannot exist. Nothing here approves or moves money.
--
-- 1. autopilot_changes: one row per change. subject 'rule' names the kind, the rule row
--    (FOREIGN KEY (tenant_id, rule_id) to autopilot_rules), the version it moved from (null on the
--    rule's first save, which also has no before) and the version it moved to (exactly one more,
--    as autopilot_rules_guard demands). subject 'pause' names no kind, rule or version. before and
--    after are objects of the values the change read and wrote (before null when there was no row
--    yet); changed_by is the login that made it. The app role may add and read a row, never change
--    or delete one: the record only grows.
--
-- The demo reset keeps it (the owner's rules and their record survive a reset,
-- src/lib/seed/reset.ts); demo_reset_clear() is not re-created. It references only tenants and
-- autopilot_rules, which the reset keeps too. A new table: no existing row is read, changed or
-- dropped.

CREATE TABLE autopilot_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject       text NOT NULL CHECK (subject IN ('rule', 'pause')),
  -- The same kinds as autopilot_rules (0070).
  kind          text CHECK (kind IN (
                  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
                  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request',
                  'bill_defer', 'collections_chase', 'pay_rule_change', 'card_match', 'money_code',
                  'pay_policy_setup', 'load_create', 'escrow_release')),
  rule_id       uuid,
  from_version  integer,
  to_version    integer,
  before        jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after         jsonb NOT NULL CHECK (jsonb_typeof(after) = 'object'),
  changed_by    text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES autopilot_rules (tenant_id, id),
  -- A rule's change names its kind, its row and the version it moved to, one more than the one it
  -- moved from; its first save has neither a from version nor a before.
  CHECK (subject <> 'rule' OR (
    kind IS NOT NULL AND rule_id IS NOT NULL AND to_version IS NOT NULL AND to_version >= 1
    AND (from_version IS NULL OR to_version = from_version + 1)
    AND ((from_version IS NULL) = (before IS NULL)))),
  -- A pause names no kind, rule or version.
  CHECK (subject <> 'pause' OR (
    kind IS NULL AND rule_id IS NULL AND from_version IS NULL AND to_version IS NULL))
);
-- A carrier's changes, newest first.
CREATE INDEX autopilot_changes_newest ON autopilot_changes (tenant_id, created_at DESC);

ALTER TABLE autopilot_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON autopilot_changes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- The record only grows: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON autopilot_changes TO payday_app;
