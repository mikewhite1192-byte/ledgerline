-- The agent's own tables: a conversation, its turns, the steps each turn took, and the proposals a
-- turn made for a person to approve. Nothing here moves money: an approved proposal reaches the
-- ledger (0006) only through the approval route, which reserves a money_actions row first.
--
-- Every table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. A reference to another
-- tenant table is a composite foreign key on (tenant_id, x_id).
--
-- Grants are narrower than the README's default: SELECT, INSERT and an UPDATE on named columns
-- only, and no DELETE at all. A turn, a step and a proposal are records of what the agent did.
-- The seed's replace mode clears them with the admin login (clearTenantAgent), after the ledger
-- rows and before the seeded tables, so the app role never needs DELETE here.
--
-- Rows hold ids, enums, numbers, lengths and categories. The two pieces of text are the person's
-- own question (turns.user_text, needed to show the thread again) and the agent's final answer
-- (turns.assistant_text). No raw prompt, tool result, untrusted text or upstream error is stored.

-- Composite references into the gateway's decision log need a key on (tenant_id, id).
ALTER TABLE gateway_decisions ADD CONSTRAINT gateway_decisions_tenant_id_key UNIQUE (tenant_id, id);

-- One thread of questions. subject_table and subject_id pin it to a record when a screen opens it
-- from one (both set or both null).
CREATE TABLE conversations (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by    text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  title         text NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  subject_table text CHECK (subject_table IN ('drivers', 'customers', 'loads', 'invoices')),
  subject_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_table IS NULL) = (subject_id IS NULL)),
  UNIQUE (tenant_id, id)
);
CREATE INDEX conversations_tenant_updated ON conversations (tenant_id, updated_at DESC);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One question and the agent's answer. The row exists, running, before any model call. summary is
-- one line the loop writes from the final answer for later turns' state summary; summary_chars is
-- the size of the state summary this turn was given (a count, never the text).
CREATE TABLE turns (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  seq              integer NOT NULL CHECK (seq > 0),
  user_text        text NOT NULL CHECK (length(user_text) BETWEEN 1 AND 2000),
  assistant_text   text NOT NULL DEFAULT '' CHECK (length(assistant_text) <= 8000),
  summary          text NOT NULL DEFAULT '' CHECK (length(summary) <= 120),
  summary_chars    integer CHECK (summary_chars >= 0),
  status           text NOT NULL CHECK (status IN ('running', 'done', 'partial', 'failed')),
  ended_reason     text CHECK (ended_reason ~ '^[a-z_]{2,40}$'),
  trace_id         text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 64),
  step_count       integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  model_call_count integer NOT NULL DEFAULT 0 CHECK (model_call_count >= 0),
  cost_nanocents   bigint NOT NULL DEFAULT 0 CHECK (cost_nanocents >= 0),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, conversation_id, seq),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX turns_tenant_trace ON turns (tenant_id, trace_id);
ALTER TABLE turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON turns
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- One thing a turn did: a model call, a tool call through the gateway, an escalation, a proposal.
-- The row is written running before the work and finished after it. label is a fixed string per
-- tool or step kind, never model text; detail holds ids, counts and categories only.
CREATE TABLE turn_steps (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  turn_id             uuid NOT NULL,
  seq                 integer NOT NULL CHECK (seq > 0),
  kind                text NOT NULL CHECK (kind IN ('model', 'tool', 'escalation', 'proposal', 'screen')),
  label               text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  state               text NOT NULL CHECK (state IN ('running', 'done', 'failed')),
  model_call_id       uuid,
  gateway_decision_id uuid,
  proposal_id         uuid,
  detail              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CHECK ((state = 'running') = (finished_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, turn_id, seq),
  FOREIGN KEY (tenant_id, turn_id) REFERENCES turns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, gateway_decision_id) REFERENCES gateway_decisions (tenant_id, id)
);
ALTER TABLE turn_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON turn_steps
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- What the agent wants done, waiting for a person. A row exists only for an allowed propose_*
-- gateway call (gateway_decision_id); amounts were sized or capped by the rules engine there.
--   kind            the gateway's proposal kinds; advance_payout is also a money_actions kind
--   amount_cents    always >= 0; direction says which way it would move
--   reasons         [{category, source?}]: categories only, shown as fixed sentences
--   sources         the engine's and the tool's validated record refs
--   args            the validated tool args (ids, cents, dates, enums; no free text)
--   exceptions      reason categories the engine or the gateway attached ('capped_to_eligible')
--   flagged_input_id  set when the turn read outside text that failed screening; once set it
--                   never changes (trigger below), and no delete may orphan it
--   dedupe_key      kind:subject_id:sha256(canonical args): the same proposal twice is one row
-- One live proposal per subject and kind (proposals_one_live_per_subject), mirroring the ledger.
CREATE TABLE proposals (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL,
  turn_id             uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('advance_payout', 'pay_correction', 'invoice_fix')),
  subject_table       text NOT NULL CHECK (subject_table IN ('customers', 'drivers', 'loads',
                        'load_state_miles', 'load_accessorials', 'driver_days', 'fuel_purchases',
                        'pay_configs', 'deduction_schedules', 'pay_items', 'advances',
                        'settlement_periods', 'settlements', 'settlement_lines', 'invoices',
                        'customer_payments', 'payment_applications')),
  subject_id          uuid NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents < 1000000000),
  direction           text NOT NULL CHECK (direction IN ('in', 'out', 'none')),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  reasons             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array'),
  sources             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array'),
  args                jsonb NOT NULL CHECK (jsonb_typeof(args) = 'object'),
  exceptions          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(exceptions) = 'array'),
  operator_verdict    text NOT NULL CHECK (operator_verdict ~ '^[a-z_]{2,40}$'),
  auditor_verdict     text CHECK (auditor_verdict IN ('agree', 'disagree', 'unknown')),
  auditor_call_id     uuid,
  auditor_agrees      boolean,
  flagged_input_id    uuid,
  gateway_decision_id uuid NOT NULL,
  dedupe_key          text NOT NULL CHECK (dedupe_key ~ '^[a-z_]{3,40}:[0-9a-f-]{36}:[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'approved', 'rejected', 'expired', 'executing',
                          'done', 'failed')),
  decided_by          text CHECK (length(decided_by) BETWEEN 1 AND 128),
  decided_at          timestamptz,
  decision_note       text CHECK (length(decision_note) <= 240),
  money_action_id     uuid,
  trace_id            text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 64),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, turn_id) REFERENCES turns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, flagged_input_id) REFERENCES untrusted_inputs (tenant_id, id),
  FOREIGN KEY (tenant_id, gateway_decision_id) REFERENCES gateway_decisions (tenant_id, id),
  -- The ledger clears its settled rows first on a reseed; the proposal then loses the link and is
  -- cleared right after.
  FOREIGN KEY (tenant_id, money_action_id) REFERENCES money_actions (tenant_id, id)
    ON DELETE SET NULL (money_action_id)
);
CREATE UNIQUE INDEX proposals_one_live_per_subject
  ON proposals (tenant_id, kind, subject_id) WHERE status IN ('proposed', 'approved', 'executing');
CREATE INDEX proposals_tenant_status ON proposals (tenant_id, status, created_at DESC);
CREATE INDEX proposals_tenant_turn ON proposals (tenant_id, turn_id);

-- Invoker rights, owned by the migrating admin. A proposal moves only forward:
--   proposed -> approved | rejected | expired
--   approved -> executing | failed
--   executing -> done | failed
-- and a flag, once set, is never cleared or changed. The raise rolls the transaction back.
CREATE FUNCTION proposals_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.flagged_input_id IS NOT NULL
     AND NEW.flagged_input_id IS DISTINCT FROM OLD.flagged_input_id THEN
    RAISE EXCEPTION 'proposals: a flag never changes once set' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('executing', 'failed'))
    OR (OLD.status = 'executing' AND NEW.status IN ('done', 'failed'))) THEN
    RAISE EXCEPTION 'proposals: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.money_action_id IS NOT NULL AND NEW.money_action_id IS NOT NULL
     AND NEW.money_action_id IS DISTINCT FROM OLD.money_action_id THEN
    RAISE EXCEPTION 'proposals: the money action never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER proposals_guard
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION proposals_guard();

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposals
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The references that close the loop, added once both ends exist.
ALTER TABLE turn_steps ADD CONSTRAINT turn_steps_proposal_fk
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id)
  ON DELETE SET NULL (proposal_id);
ALTER TABLE gateway_decisions ADD CONSTRAINT gateway_decisions_turn_fk
  FOREIGN KEY (tenant_id, turn_id) REFERENCES turns (tenant_id, id) ON DELETE SET NULL (turn_id);
-- The ledger's open item: a money action names the proposal it carried out, and that proposal
-- cannot be deleted while the action exists.
ALTER TABLE money_actions ADD CONSTRAINT money_actions_proposal_fk
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id);

GRANT SELECT, INSERT ON conversations, turns, turn_steps, proposals TO payday_app;
GRANT UPDATE (title, updated_at) ON conversations TO payday_app;
GRANT UPDATE (assistant_text, summary, summary_chars, status, ended_reason, step_count,
              model_call_count, cost_nanocents, finished_at) ON turns TO payday_app;
GRANT UPDATE (state, model_call_id, gateway_decision_id, proposal_id, detail, finished_at)
  ON turn_steps TO payday_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, money_action_id, auditor_verdict,
              auditor_call_id, auditor_agrees, exceptions, flagged_input_id, updated_at)
  ON proposals TO payday_app;
