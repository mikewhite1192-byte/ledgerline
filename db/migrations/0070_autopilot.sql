-- AUTOPILOT (0070): the owner's own rule per action kind (Off, Ask me, Auto within limits), one
-- Pause switch per carrier, and the record of what the autopilot decided on each proposal. The
-- model never decides: a pure policy in code (src/lib/autopilot/policy.ts) reads these rows, the
-- proposal's stored checks and today's totals, and only then may the carrier's autopilot login
-- approve, through the same gate a person's approval passes (src/lib/proposals/execute.ts).
--
-- 1. autopilot_rules: one row per carrier and kind. mode off | ask | auto; max_cents (one item),
--    day_max_cents and day_max_count (the carrier's local day), all whole numbers with CHECKs.
--    version starts at 1 and goes up by exactly one on every change to the rule
--    (autopilot_rules_guard), so an approval names the very rule it was decided on. The app role
--    may add and change a rule, never delete one (a rule goes with its carrier).
-- 2. autopilot_state: one row per carrier. paused_at and paused_by are set together; paused_until
--    null means paused until a person resumes it, otherwise the pause ends by itself then (the
--    demo reset's 30 minutes). No row means not paused. The app role may add and change it, never
--    delete it.
-- 3. proposals.autopilot_decision: null until the autopilot looked at the proposal, then an object
--    with mode auto | ask | off, its reason word and the rule and totals it read. Set once, never
--    changed (proposals_autopilot_guard): auto only in the statement that moves the proposal from
--    proposed to approved and names the carrier's autopilot login as decided_by; ask or off only
--    while the proposal stays proposed. The autopilot login approves nothing without an auto
--    decision in that same statement, and a new proposal never carries a decision. The check is
--    added NOT VALID (every row already there is null) and validated by the next file.
-- 4. desk_log's source check, re-created with the new 'autopilot' source (subject table
--    proposals), NOT VALID, validated by the next file. Every source the old check listed stays.
-- 5. The autopilot login service:autopilot:<tenant> for every carrier: staff, never admin, and its
--    sub is not a Cognito id, so nobody signs in as it and the approve routes never see it (the
--    demo setup adds it for carriers made later, scripts/lib/demo-rows.ts).
-- 6. The starting rules for the two invented demo carriers: Auto on invoice_post, card_match and
--    payment_reapply (nothing leaves the company); every other kind has no row, which reads as
--    Ask me. Nothing runs until flags.autopilot is armed in its own release.
--
-- The demo reset keeps both new tables (the owner's rules and the pause survive a reset; the reset
-- only sets a 30 minute pause, src/lib/seed/reset.ts); a decision is a column of proposals and goes
-- with its row, so demo_reset_clear() is not re-created. Both tables reference only tenants. No
-- existing row is changed or dropped.

-- 1. The rules.
CREATE TABLE autopilot_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'advance_payout', 'pay_correction', 'invoice_fix', 'load_rate_fill', 'invoice_post',
                   'payment_reapply', 'settlement_approve', 'detention_charge', 'factoring_request',
                   'bill_defer', 'collections_chase', 'pay_rule_change', 'card_match', 'money_code',
                   'pay_policy_setup', 'load_create', 'escrow_release')),
  mode           text NOT NULL CHECK (mode IN ('off', 'ask', 'auto')),
  max_cents      bigint NOT NULL CHECK (max_cents >= 0 AND max_cents < 1000000000),
  day_max_cents  bigint NOT NULL CHECK (day_max_cents >= 0 AND day_max_cents < 1000000000),
  day_max_count  integer NOT NULL CHECK (day_max_count >= 0 AND day_max_count <= 10000),
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by     text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind),
  UNIQUE (tenant_id, id),
  CHECK (max_cents <= day_max_cents)
);

ALTER TABLE autopilot_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON autopilot_rules
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE, and the kind and the carrier never change.
GRANT SELECT, INSERT ON autopilot_rules TO payday_app;
GRANT UPDATE (mode, max_cents, day_max_cents, day_max_count, version, updated_by, updated_at)
  ON autopilot_rules TO payday_app;

-- Invoker rights, owned by the migrating admin. A new rule starts at version 1; a change to its
-- mode or limits moves the version up by exactly one, and the version never moves on its own. The
-- raise rolls the transaction back.
CREATE FUNCTION autopilot_rules_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'autopilot_rules: a new rule starts at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.max_cents IS DISTINCT FROM OLD.max_cents
     OR NEW.day_max_cents IS DISTINCT FROM OLD.day_max_cents
     OR NEW.day_max_count IS DISTINCT FROM OLD.day_max_count THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'autopilot_rules: a changed rule moves its version up by one' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'autopilot_rules: the version moves only with a change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER autopilot_rules_guard
  BEFORE INSERT OR UPDATE ON autopilot_rules
  FOR EACH ROW EXECUTE FUNCTION autopilot_rules_guard();

-- 2. The pause.
CREATE TABLE autopilot_state (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  paused_at     timestamptz,
  -- The login that paused it, or 'demo_reset'.
  paused_by     text CHECK (length(paused_by) BETWEEN 1 AND 200),
  -- Null: until a person resumes it.
  paused_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((paused_at IS NULL) = (paused_by IS NULL)),
  CHECK (paused_until IS NULL OR (paused_at IS NOT NULL AND paused_until > paused_at))
);

ALTER TABLE autopilot_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON autopilot_state
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- No DELETE: the row goes only with its carrier.
GRANT SELECT, INSERT ON autopilot_state TO payday_app;
GRANT UPDATE (paused_at, paused_by, paused_until, updated_at) ON autopilot_state TO payday_app;

-- 3. The decision on each proposal.
ALTER TABLE proposals
  ADD COLUMN autopilot_decision jsonb,
  ADD CONSTRAINT proposals_autopilot_decision_check CHECK (
    autopilot_decision IS NULL
    OR (jsonb_typeof(autopilot_decision) = 'object'
        AND coalesce(autopilot_decision->>'mode', '') IN ('auto', 'ask', 'off')
        AND (autopilot_decision->>'mode' <> 'auto' OR status <> 'proposed'))) NOT VALID;

GRANT UPDATE (autopilot_decision) ON proposals TO payday_app;

-- Invoker rights, owned by the migrating admin. The raise rolls the transaction back. Every
-- comparison is null-safe (IS NOT DISTINCT FROM, coalesce), so a null never lets a row through.
CREATE FUNCTION proposals_autopilot_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_login text := 'service:autopilot:' || CAST(NEW.tenant_id AS text);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.autopilot_decision IS NOT NULL OR NEW.decided_by IS NOT DISTINCT FROM v_login THEN
      RAISE EXCEPTION 'proposals: a new proposal carries no autopilot decision' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.autopilot_decision IS NOT NULL AND NEW.autopilot_decision IS DISTINCT FROM OLD.autopilot_decision THEN
    RAISE EXCEPTION 'proposals: an autopilot decision never changes once set' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.autopilot_decision IS NULL AND NEW.autopilot_decision IS NOT NULL THEN
    IF NEW.autopilot_decision->>'mode' IS NOT DISTINCT FROM 'auto' THEN
      IF NOT (OLD.status = 'proposed' AND NEW.status = 'approved'
              AND NEW.decided_by IS NOT DISTINCT FROM v_login) THEN
        RAISE EXCEPTION 'proposals: auto is set only with the autopilot approval' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT (OLD.status = 'proposed' AND NEW.status = 'proposed') THEN
      RAISE EXCEPTION 'proposals: ask or off is set only while proposed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The autopilot login decides only by an auto approval in this same statement, or by expiring
  -- a proposal past its age (the gate's expiry, which any member's approval attempt writes).
  IF NEW.decided_by IS NOT DISTINCT FROM v_login AND OLD.decided_by IS DISTINCT FROM v_login THEN
    IF NOT ((OLD.status = 'proposed' AND NEW.status = 'approved' AND OLD.autopilot_decision IS NULL
             AND coalesce(NEW.autopilot_decision->>'mode', '') = 'auto')
            OR (OLD.status = 'proposed' AND NEW.status = 'expired')) THEN
      RAISE EXCEPTION 'proposals: the autopilot approves only under an auto decision' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER proposals_autopilot_guard
  BEFORE INSERT OR UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_autopilot_guard();

-- 4. The desk log's sources, with the autopilot's.
ALTER TABLE desk_log DROP CONSTRAINT desk_log_source_check;
ALTER TABLE desk_log ADD CONSTRAINT desk_log_source_check CHECK (source IN (
  'card_transaction', 'inbound_message', 'voice_note', 'customer_payment', 'audit', 'sweep',
  'collections', 'cash_check', 'autopilot')) NOT VALID;

-- 5. The autopilot login for every carrier already here.
INSERT INTO memberships (tenant_id, cognito_sub, email, role)
SELECT t.id, 'service:autopilot:' || CAST(t.id AS text), 'autopilot@' || t.slug || '.invalid', 'staff'
  FROM tenants t
ON CONFLICT (cognito_sub) DO NOTHING;

-- 6. The starting rules for the two invented demo carriers (the same values as
-- src/lib/autopilot/defaults.ts).
INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
SELECT t.id, d.kind, 'auto', d.max_cents, d.day_max_cents, d.day_max_count, 'setup'
  FROM tenants t
 CROSS JOIN (VALUES ('invoice_post', 200000, 1000000, 25),
                    ('card_match', 50000, 300000, 40),
                    ('payment_reapply', 200000, 1000000, 25))
       AS d (kind, max_cents, day_max_cents, day_max_count)
 WHERE t.slug IN ('blue-ridge', 'prairie-wind')
ON CONFLICT (tenant_id, kind) DO NOTHING;
