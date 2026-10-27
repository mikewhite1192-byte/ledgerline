-- Driver notes: a short note in the driver's own language that explains one settled week's pay.
-- Muse Spark writes it from the stored paystub; code checks every number in it against that
-- paystub before a person sees it; a person approves or rejects it; only an approved note reaches
-- the driver. Nothing here moves money or changes a settlement.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. Every reference to
-- another tenant table is a composite foreign key on (tenant_id, x_id).
--
-- Grants follow 0009, narrower than the README's default: SELECT, INSERT and an UPDATE on named
-- columns only, and no DELETE. A note is the record of what was drafted and who approved it. The
-- seed's replace mode clears notes with the admin login (clearTenantAgent), before the settlements
-- and drivers they name, so the app role never needs DELETE here.
--
-- Rows hold ids, enums, cents, line numbers and categories. The one piece of text is the note
-- itself (body), and only once it passed the check: a draft that failed keeps no text, only the
-- category and the amounts the check compared. No prompt, model output that failed, or upstream
-- error is stored.

-- The language a driver's notes are written in. Existing drivers read English.
ALTER TABLE drivers ADD COLUMN preferred_language text NOT NULL DEFAULT 'en'
  CHECK (preferred_language IN ('en', 'es'));

-- A note names the model call that wrote it, and that call must be the same carrier's. The
-- composite foreign key below needs a (tenant_id, id) key on the model ledger. id is already its
-- primary key, so every existing row meets it; nothing else on model_calls changes (its policy,
-- forced row-level security and grants stay as 0003 left them).
ALTER TABLE model_calls ADD CONSTRAINT model_calls_tenant_id_id_key UNIQUE (tenant_id, id);

-- One note per settlement. The row is written (drafting) before the model call, so a second
-- click or a crash never makes a second note: UNIQUE (tenant_id, settlement_id) is the dedupe key.
--
-- status:
--   drafting  reserved before the model call; body is not set yet
--   drafted   the note passed the check and waits for a person
--   refused   the check or the model call failed; no body, refusal_category says why
--   over_cap  not drafted, waiting for the next pass: the period's note spend reached its cap, or
--             the model call was turned down before any request went out (no call was made)
--   approved  a person approved it; delivered to the driver view at the same moment
--   rejected  a person rejected it; the driver sees the code-built fallback line
--
-- trace_id groups the note's model call in model_calls (the batch cap sums the period's calls by
-- it); model_call_id names the call whose answer was checked. verification holds the amounts the
-- check allowed and found, in cents, and the category.
CREATE TABLE driver_notes (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id    uuid NOT NULL,
  driver_id        uuid NOT NULL,
  period_id        uuid NOT NULL,
  language         text NOT NULL CHECK (language IN ('en', 'es')),
  status           text NOT NULL
                   CHECK (status IN ('drafting', 'drafted', 'refused', 'over_cap', 'approved', 'rejected')),
  body             text CHECK (length(body) BETWEEN 1 AND 1200),
  cited_seqs       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cited_seqs) = 'array'),
  refusal_category text CHECK (refusal_category ~ '^[a-z_]{2,40}$'),
  verification     jsonb CHECK (jsonb_typeof(verification) = 'object'),
  trace_id         uuid NOT NULL,
  model_call_id    uuid,
  decided_by       text CHECK (length(decided_by) BETWEEN 1 AND 128),
  decided_at       timestamptz,
  delivered_at     timestamptz,
  channel          text CHECK (channel IN ('driver_view', 'email')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Text exists exactly when the note passed the check.
  CHECK ((status IN ('drafted', 'approved', 'rejected')) = (body IS NOT NULL)),
  CHECK ((status = 'refused') = (refusal_category IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  -- An approved note is delivered at approval; nothing else is ever delivered.
  CHECK ((status = 'approved') = (delivered_at IS NOT NULL)),
  CHECK ((delivered_at IS NULL) = (channel IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, settlement_id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES settlements (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES settlement_periods (tenant_id, id),
  -- Null until the call is made, and left null when it never was (no row to point at).
  FOREIGN KEY (tenant_id, model_call_id) REFERENCES model_calls (tenant_id, id)
);
CREATE INDEX driver_notes_tenant_period ON driver_notes (tenant_id, period_id);

-- What a note may become, and what never changes. The text, its language, its citations and the
-- check's record are written once, on the step out of drafting, and never again: approval never
-- edits the text. Status moves forward only. over_cap may go back to drafting (the period's cap
-- was raised and someone drafts the rest), and drafting may go back to over_cap while the note
-- names no model call (its call was turned down before any request went out); refused, rejected
-- and approved are final. The channel may move from the driver view to email once, when an
-- allowlisted email is sent. A new row is only ever a bare reservation (drafting, or over_cap with
-- no call made): no text, citations, check record, refusal, model call, decision or delivery, so
-- every later state goes through the update rules and nothing can be inserted already approved.
CREATE FUNCTION driver_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('drafting', 'over_cap')
       OR NEW.body IS NOT NULL
       OR NEW.cited_seqs IS DISTINCT FROM CAST('[]' AS jsonb)
       OR NEW.verification IS NOT NULL
       OR NEW.refusal_category IS NOT NULL
       OR NEW.model_call_id IS NOT NULL
       OR NEW.decided_by IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.delivered_at IS NOT NULL
       OR NEW.channel IS NOT NULL THEN
      RAISE EXCEPTION 'driver_notes: a new note must be a bare reservation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'driver_notes: identity and language never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused'))
    OR (OLD.status = 'over_cap' AND NEW.status = 'drafting')
    OR (OLD.status = 'drafting' AND NEW.status = 'over_cap'
        AND OLD.model_call_id IS NULL AND NEW.model_call_id IS NULL)
    OR (OLD.status = 'drafted' AND NEW.status IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'driver_notes: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused'))
     AND (NEW.body IS DISTINCT FROM OLD.body
       OR NEW.cited_seqs IS DISTINCT FROM OLD.cited_seqs
       OR NEW.verification IS DISTINCT FROM OLD.verification
       OR NEW.refusal_category IS DISTINCT FROM OLD.refusal_category
       OR NEW.model_call_id IS DISTINCT FROM OLD.model_call_id) THEN
    RAISE EXCEPTION 'driver_notes: the text of a note never changes once written'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status = 'drafted' AND NEW.status IN ('approved', 'rejected'))
     AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
    RAISE EXCEPTION 'driver_notes: a decision never changes once made' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel IS DISTINCT FROM OLD.channel
     AND NOT (OLD.status = 'drafted' AND NEW.status = 'approved' AND NEW.channel = 'driver_view')
     AND NOT (OLD.status = 'approved' AND NEW.status = 'approved'
              AND OLD.channel = 'driver_view' AND NEW.channel = 'email') THEN
    RAISE EXCEPTION 'driver_notes: delivery channel change not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER driver_notes_guard
  BEFORE INSERT OR UPDATE ON driver_notes
  FOR EACH ROW EXECUTE FUNCTION driver_notes_guard();

ALTER TABLE driver_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON driver_notes
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON driver_notes TO payday_app;
GRANT UPDATE (status, body, cited_seqs, refusal_category, verification, model_call_id, decided_by,
              decided_at, delivered_at, channel, updated_at)
  ON driver_notes TO payday_app;
