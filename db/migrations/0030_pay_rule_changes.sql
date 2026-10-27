-- Pay rules changed by talking: a person's plain sentence becomes a typed change the engine sizes,
-- the auditor checks and a person approves; the approval writes a new dated version. History is
-- frozen: a version any approved or paid settlement names is never edited.

-- 1. The proposal kind pay_rule_change. Full union across main and every open branch, this one
--    included, in the same order as 0022: production applies migrations in merge order and a
--    fresh database in number order, so every migration that re-creates this check lists all of
--    them and whichever runs last leaves the same check. Any later migration that re-creates this
--    check re-lists them all.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN (
  'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
  'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request', 'bill_defer',
  'collections_chase', 'pay_rule_change'));

-- 2. A version an approval wrote. 0005 declared the check inline, so Postgres named it
--    pay_configs_source_check (checked on a fresh database before this was written).
ALTER TABLE pay_configs DROP CONSTRAINT pay_configs_source_check;
ALTER TABLE pay_configs ADD CONSTRAINT pay_configs_source_check
  CHECK (source IN ('seed', 'ui', 'proposal'));

-- 3. One row per executed change: which proposal, which version it created or edited, the knob,
--    the two values as text (cents, bps or an enum, as the proposal's args hold them), the date
--    asked for and the date it took effect. The version row is the rules; this is the diff.
CREATE TABLE pay_rule_changes (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pay_config_id   uuid NOT NULL,
  proposal_id     uuid,
  rule_key        text NOT NULL CHECK (rule_key ~ '^[a-z_]{3,40}$'),
  old_value       text NOT NULL CHECK (length(old_value) BETWEEN 1 AND 40),
  new_value       text NOT NULL CHECK (length(new_value) BETWEEN 1 AND 40),
  asked_from      date NOT NULL,
  effective_from  date NOT NULL,
  applied         text NOT NULL CHECK (applied IN ('new_version', 'edited_version')),
  decided_by      text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 128),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_from >= asked_from),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, proposal_id),
  FOREIGN KEY (tenant_id, pay_config_id) REFERENCES pay_configs (tenant_id, id) ON DELETE CASCADE,
  -- The demo reset clears these rows before the proposals (0036); SET NULL keeps the diff with
  -- its version should a proposal ever go first.
  -- ON DELETE SET NULL with a column list needs Postgres 15 or later.
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id)
    ON DELETE SET NULL (proposal_id)
);
CREATE INDEX pay_rule_changes_version ON pay_rule_changes (tenant_id, pay_config_id, created_at DESC);
ALTER TABLE pay_rule_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_rule_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_rule_changes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, DELETE ON pay_rule_changes TO payday_app;
