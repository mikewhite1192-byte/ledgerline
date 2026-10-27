-- The money ledger: one row per outside write (a payout, or a post to the accounting system),
-- reserved before the call and settled after it. Nothing here moves money; src/lib/money writes
-- these rows around each adapter call.
--
-- Same conventions as 0004 and 0005: tenant_id, forced row-level security with the one policy,
-- app-made ids, composite (tenant_id, x_id) foreign keys, bigint cents. Two differences: the app
-- role gets no DELETE (a ledger row is the record), and a trigger enforces the state machine:
--   reserved -> sent -> confirmed | failed | unknown
--   reserved -> failed            (refused before any call)
--   unknown  -> confirmed | failed only when settled by a read-back; unknown -> unknown bumps the
--                                 check count
--   confirmed and failed are final.
-- The subject (an advance, settlement, invoice or customer payment) and the counterparty (a
-- driver or customer) are not foreign keys: four subject tables share one column pair, and a
-- ledger row must outlive a voided or reseeded subject. The app checks both, same tenant, in the
-- approval transaction.

-- The approver is a membership of the same tenant, so memberships needs the composite key.
ALTER TABLE memberships ADD CONSTRAINT memberships_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE money_actions (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('advance_payout', 'advance_expense',
                           'settlement_payout', 'settlement_bill', 'settlement_bill_payment',
                           'invoice', 'customer_payment')),
  channel                text NOT NULL CHECK (channel IN ('payment', 'accounting')),
  subject_table          text NOT NULL CHECK (subject_table IN ('advances', 'settlements',
                           'invoices', 'customer_payments')),
  subject_id             uuid NOT NULL,
  attempt                integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  -- kind:subject:attempt, and the outside request id is the row id without dashes. Both derive
  -- from stored values, so a crashed process re-derives the same outside request.
  idempotency_key        text NOT NULL CHECK (idempotency_key ~ '^[a-z_]+:[0-9a-f-]{36}:[0-9]{1,2}$'),
  request_id             text NOT NULL CHECK (request_id ~ '^[0-9a-f]{32}$'),
  amount_cents           bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  counterparty_table     text NOT NULL CHECK (counterparty_table IN ('drivers', 'customers')),
  counterparty_id        uuid NOT NULL,
  state                  text NOT NULL DEFAULT 'reserved'
                         CHECK (state IN ('reserved', 'sent', 'confirmed', 'failed', 'unknown')),
  failure_category       text CHECK (failure_category IN ('disabled', 'not_connected',
                           'not_configured', 'validation', 'duplicate', 'auth', 'rate_limited',
                           'unavailable', 'timeout', 'network', 'amount_mismatch',
                           'outside_failed', 'unknown')),
  settled_via            text CHECK (settled_via IN ('response', 'read_back', 'refused')),
  outside_system         text CHECK (outside_system IN ('mock', 'stripe_test', 'qbo_sandbox')),
  outside_type           text CHECK (length(outside_type) BETWEEN 2 AND 40),
  outside_id             text CHECK (length(outside_id) BETWEEN 1 AND 120),
  outside_ref            text CHECK (length(outside_ref) BETWEEN 1 AND 40),
  outside_amount_cents   bigint CHECK (outside_amount_cents >= 0),
  proposed_by            text NOT NULL CHECK (proposed_by IN ('agent', 'person')),
  -- No foreign key until the proposals table exists.
  proposal_id            uuid,
  trace_id               uuid,
  approver_membership_id uuid NOT NULL,
  check_count            integer NOT NULL DEFAULT 0 CHECK (check_count BETWEEN 0 AND 50),
  created_at             timestamptz NOT NULL DEFAULT now(),
  sent_at                timestamptz,
  settled_at             timestamptz,
  last_checked_at        timestamptz,
  CHECK (idempotency_key = kind || ':' || CAST(subject_id AS text) || ':' || CAST(attempt AS text)),
  CHECK (request_id = replace(CAST(id AS text), '-', '')),
  CHECK ((channel = 'payment') = (kind IN ('advance_payout', 'settlement_payout'))),
  CHECK ((kind LIKE 'advance%') = (subject_table = 'advances')),
  CHECK ((kind LIKE 'settlement%') = (subject_table = 'settlements')),
  CHECK ((kind = 'invoice') = (subject_table = 'invoices')),
  CHECK ((kind = 'customer_payment') = (subject_table = 'customer_payments')),
  CHECK ((counterparty_table = 'customers') = (kind IN ('invoice', 'customer_payment'))),
  CHECK (state IN ('reserved', 'failed') OR sent_at IS NOT NULL),
  CHECK (state NOT IN ('confirmed', 'failed') OR (settled_at IS NOT NULL AND settled_via IS NOT NULL)),
  CHECK (state IN ('confirmed', 'failed') OR (settled_at IS NULL AND settled_via IS NULL)),
  CHECK (state <> 'confirmed' OR (outside_id IS NOT NULL AND outside_system IS NOT NULL
                                  AND outside_amount_cents = amount_cents)),
  CHECK (state <> 'failed' OR failure_category IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, approver_membership_id) REFERENCES memberships (tenant_id, id)
);
-- One live row per subject and kind, whatever key a caller builds: "pay this advance" exists at
-- most once until a definite failure frees it for a person to retry as attempt + 1.
CREATE UNIQUE INDEX money_actions_one_live_per_subject
  ON money_actions (tenant_id, kind, subject_id) WHERE state <> 'failed';
CREATE INDEX money_actions_tenant_subject_idx ON money_actions (tenant_id, subject_table, subject_id);
CREATE INDEX money_actions_tenant_pending_idx
  ON money_actions (tenant_id, state, sent_at) WHERE state IN ('sent', 'unknown');

-- Invoker rights (never security definer), owned by the migrating admin. Raises on any move the
-- state machine above does not allow, on a new row that is not a bare reservation, and on any
-- change to what was approved (the identity columns below). The raise rolls the transaction back.
CREATE FUNCTION money_actions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.check_count <> 0 OR NEW.failure_category IS NOT NULL
       OR NEW.settled_via IS NOT NULL OR NEW.outside_system IS NOT NULL
       OR NEW.outside_type IS NOT NULL OR NEW.outside_id IS NOT NULL
       OR NEW.outside_ref IS NOT NULL OR NEW.outside_amount_cents IS NOT NULL
       OR NEW.sent_at IS NOT NULL OR NEW.settled_at IS NOT NULL
       OR NEW.last_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'money_actions: a new row must be a bare reservation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.subject_table IS DISTINCT FROM OLD.subject_table
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.counterparty_table IS DISTINCT FROM OLD.counterparty_table
     OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.approver_membership_id IS DISTINCT FROM OLD.approver_membership_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'money_actions: what was approved never changes'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'money_actions: a settled row is final' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('sent', 'failed'))
       OR (OLD.state = 'sent' AND NEW.state IN ('confirmed', 'failed', 'unknown'))
       OR (OLD.state = 'unknown' AND NEW.state IN ('confirmed', 'failed', 'unknown'))) THEN
    RAISE EXCEPTION 'money_actions: transition not allowed' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'failed'
     AND COALESCE(NEW.settled_via, '') <> 'refused' THEN
    RAISE EXCEPTION 'money_actions: a reservation fails only as refused'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'sent' AND NEW.state IN ('confirmed', 'failed')
     AND COALESCE(NEW.settled_via, '') NOT IN ('response', 'read_back') THEN
    RAISE EXCEPTION 'money_actions: a sent row settles by response or read-back'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'unknown' AND NEW.state IN ('confirmed', 'failed')
     AND COALESCE(NEW.settled_via, '') <> 'read_back' THEN
    RAISE EXCEPTION 'money_actions: an unknown row settles only by read-back'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'money_actions: sent_at never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.check_count < OLD.check_count THEN
    RAISE EXCEPTION 'money_actions: the check count never goes down'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER money_actions_guard
  BEFORE INSERT OR UPDATE ON money_actions
  FOR EACH ROW EXECUTE FUNCTION money_actions_guard();

ALTER TABLE money_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON money_actions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- No DELETE: a ledger row is the record. A tenant's rows go only with the tenant (cascade).
GRANT SELECT, INSERT, UPDATE ON money_actions TO payday_app;
