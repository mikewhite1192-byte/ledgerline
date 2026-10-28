-- Briefs: a short written account of the carrier's own figures, for the owner. The rules engine
-- computes every figure (integer cents, basis points, whole counts) and the row keeps them; Muse
-- Spark words them; code checks every number in the words against the figures before anyone reads
-- them. Nothing here moves money or changes a record. The profit brief (kind profit_week) is the
-- first kind; the quarter review (kind quarter) reuses the same table later, so the shape stays
-- general: figures and body are jsonb whose shape each kind defines.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Every reference to another tenant table is a
-- composite foreign key on (tenant_id, x_id). It is a seeded table (TENANT_TABLES, none planted),
-- so the seed's replace and the demo reset delete its rows as the app role: DELETE is granted for
-- that, and nothing in the app deletes a brief.
--
-- Rows hold dates, enums, the figures and categories. The one piece of model text is the body, and
-- only once it passed the check: a brief that failed keeps no text, only the category and what the
-- check counted. No prompt, failed reply or upstream error is stored.
--
-- status:
--   drafting    reserved before the model call; no body yet
--   drafted     the words passed the number check
--   refused     the check or the model call failed; refusal_category says why, no body
--   over_cap    no request went out (models off, over a cap); refusal_category says which
--   superseded  a refused or over_cap brief that a later "Write again" replaced; kept for the record
--
-- One live brief per (tenant, kind, period start): briefs_one_live is the dedupe key, so a second
-- click, a second tab or a retry never drafts the same week twice, and a drafted brief is never
-- replaced. trace_id groups the brief's model call in model_calls; model_call_id names the call whose
-- answer was checked and must be the same carrier's.
CREATE TABLE briefs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('profit_week', 'quarter')),
  period_start     date NOT NULL,
  period_end       date NOT NULL CHECK (period_end >= period_start),
  as_of            date NOT NULL,
  status           text NOT NULL
                   CHECK (status IN ('drafting', 'drafted', 'refused', 'over_cap', 'superseded')),
  -- [{key, label, kind: cents|bps|int|date|text, value, source: {table, id} | {report, args}}]
  figures          jsonb NOT NULL CHECK (jsonb_typeof(figures) = 'array'),
  -- profit_week: {text}; quarter: {went_well[], problems[], recovered[], change[]}
  body             jsonb CHECK (jsonb_typeof(body) = 'object'),
  refusal_category text CHECK (refusal_category ~ '^[a-z_]{2,40}$'),
  verification     jsonb CHECK (jsonb_typeof(verification) = 'object'),
  model            text CHECK (model IN ('spark', 'wonder')),
  trace_id         uuid,
  model_call_id    uuid,
  created_by       text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Text exists exactly when the brief passed the check.
  CHECK ((status = 'drafted') = (body IS NOT NULL)),
  -- A refusal always says why; a live brief never carries a reason.
  CHECK (status <> 'refused' OR refusal_category IS NOT NULL),
  CHECK (status NOT IN ('drafting', 'drafted') OR refusal_category IS NULL),
  -- Null until the call is made, and left null when it never was (no row to point at).
  FOREIGN KEY (tenant_id, model_call_id) REFERENCES model_calls (tenant_id, id)
);
CREATE UNIQUE INDEX briefs_one_live ON briefs (tenant_id, kind, period_start)
  WHERE status IN ('drafting', 'drafted');
CREATE INDEX briefs_tenant_kind_period ON briefs (tenant_id, kind, period_start);

-- What a brief may become, and what never changes. A new row is only ever a bare reservation
-- (drafting, with its figures and no body, check record, refusal or model call). The body, the
-- check record, the refusal and the model call are written once, on the step out of drafting.
-- Status moves forward only: drafting to drafted, refused or over_cap; refused or over_cap to
-- superseded. A drafted brief is final. The figures, the period and who asked never change.
CREATE FUNCTION briefs_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'drafting'
       OR NEW.body IS NOT NULL
       OR NEW.verification IS NOT NULL
       OR NEW.refusal_category IS NOT NULL
       OR NEW.model_call_id IS NOT NULL THEN
      RAISE EXCEPTION 'briefs: a new brief must be a bare reservation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.figures IS DISTINCT FROM OLD.figures
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'briefs: identity and figures never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused', 'over_cap'))
    OR (OLD.status IN ('refused', 'over_cap') AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'briefs: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused', 'over_cap'))
     AND (NEW.body IS DISTINCT FROM OLD.body
       OR NEW.verification IS DISTINCT FROM OLD.verification
       OR NEW.refusal_category IS DISTINCT FROM OLD.refusal_category
       OR NEW.model_call_id IS DISTINCT FROM OLD.model_call_id) THEN
    RAISE EXCEPTION 'briefs: the words of a brief never change once written' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER briefs_guard
  BEFORE INSERT OR UPDATE ON briefs
  FOR EACH ROW EXECUTE FUNCTION briefs_guard();

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON briefs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, DELETE ON briefs TO payday_app;
GRANT UPDATE (status, body, refusal_category, verification, model_call_id, updated_at) ON briefs TO payday_app;
