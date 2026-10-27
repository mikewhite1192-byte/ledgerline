-- Fuel checks: every fill-up held against the truck's tank, the load's route and the driver's day.
-- A person clicks "Check this week's fuel"; the rules engine finds the problems and each becomes
-- one fuel_findings row, keyed so a second run never duplicates one. Nothing here moves money: a
-- finding's main action drafts a pay correction a person approves on its card, as always.
--
-- Additive only. This file does not touch the proposal kinds, the pay item kinds, the money
-- actions guard or the escrow balance check: the fuel proposals are the existing pay_correction
-- kind, and a later migration re-creates those shared checks whole. The demo reset learns to empty
-- the two fuel tables in 0034, which re-creates demo_reset_clear() on its own.

-- fuel_check_runs: one row per click. as_of is the tenant-local day the run checked (NULL only
-- for a run that failed before it could read the carrier's zone). checked_count is the fill-ups
-- read, found_count the findings the engine listed, compare_count the receipt compares made and
-- spent_cents their worst-case cost. One running run per carrier (fuel_check_runs_one_running):
-- a second click waits for the first, or takes over one left running too long.
CREATE TABLE fuel_check_runs (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  as_of         date,
  started_by    text NOT NULL CHECK (length(started_by) BETWEEN 1 AND 128),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  fail_category text CHECK (fail_category ~ '^[a-z_]{2,40}$'),
  checked_count integer NOT NULL DEFAULT 0 CHECK (checked_count >= 0),
  found_count   integer NOT NULL DEFAULT 0 CHECK (found_count >= 0),
  compare_count integer NOT NULL DEFAULT 0 CHECK (compare_count >= 0),
  spent_cents   integer NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'failed') = (fail_category IS NOT NULL)),
  CHECK (status = 'failed' OR as_of IS NOT NULL),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX fuel_check_runs_one_running ON fuel_check_runs (tenant_id) WHERE status = 'running';
CREATE INDEX fuel_check_runs_tenant_started ON fuel_check_runs (tenant_id, started_at DESC);

-- A run is running until it is done or failed, and then never changes; its identity never does.
CREATE FUNCTION fuel_check_runs_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.started_by IS DISTINCT FROM OLD.started_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'fuel_check_runs: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'fuel_check_runs: a finished run never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fuel_check_runs_guard BEFORE UPDATE ON fuel_check_runs
  FOR EACH ROW EXECUTE FUNCTION fuel_check_runs_guard();

ALTER TABLE fuel_check_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_check_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fuel_check_runs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON fuel_check_runs TO payday_app;
GRANT UPDATE (status, fail_category, checked_count, found_count, compare_count, spent_cents, finished_at)
  ON fuel_check_runs TO payday_app;

-- fuel_findings: one row per problem. finding_key (check:purchase, and :older purchase for a
-- duplicate) is the dedupe key: a rerun updates the live fields of the row it finds again and
-- never its status, so a person's decision stands; an open row the engine no longer finds is
-- cleared, and comes back open if it is found again.
--   amount_cents     the whole fill-up at fault
--   suggested_cents  the engine's signed correction (negative takes money back), inside the
--                    correction limit; no_suggestion says why there is none
--   sources          [{table, id}], the first one the fill-up at fault
--   compare_*        for a duplicate only: what the receipt compare saw in the two photos, kept
--                    as an enum, never model text. A verdict (same or different) or an unreadable
--                    answer is final; no photos, the budget or a timeout may be tried again.
CREATE TABLE fuel_findings (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  finding_key          text NOT NULL CHECK (length(finding_key) BETWEEN 1 AND 200),
  check_name           text NOT NULL CHECK (check_name IN ('fuel_off_route', 'fuel_over_tank',
                         'fuel_while_parked', 'fuel_duplicate')),
  category             text NOT NULL CHECK (category ~ '^[a-z_]{2,40}$'),
  driver_id            uuid NOT NULL,
  fuel_purchase_id     uuid NOT NULL,
  other_purchase_id    uuid,
  load_id              uuid,
  pay_item_id          uuid,
  purchased_on         date NOT NULL,
  state                char(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  gallons_milli        integer NOT NULL CHECK (gallons_milli > 0),
  tank_gallons         integer NOT NULL CHECK (tank_gallons BETWEEN 100 AND 400),
  paid_with            text NOT NULL CHECK (paid_with IN ('company_card', 'driver_own')),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents < 1000000000),
  excess_cents         bigint CHECK (excess_cents >= 0 AND excess_cents < 1000000000),
  suggested_cents      bigint CHECK (suggested_cents <> 0 AND abs(suggested_cents) < 1000000000),
  no_suggestion        text CHECK (no_suggestion IN ('driver_paid', 'already_deducted', 'over_tank',
                         'card_double_charge', 'not_paid_back', 'over_limit')),
  sources              jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'proposed', 'dismissed', 'cleared')),
  dismiss_category     text CHECK (dismiss_category IN ('driver_explained', 'pump_error',
                         'provider_reversed', 'other')),
  compare_verdict      text CHECK (compare_verdict IN ('same', 'different', 'unknown')),
  compare_confidence   text CHECK (compare_confidence IN ('high', 'medium', 'low')),
  compare_category     text CHECK (compare_category IN ('budget', 'timeout', 'unreadable', 'no_photos')),
  compare_call_id      uuid,
  compare_document_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(compare_document_ids) = 'array'),
  proposal_id          uuid,
  first_run_id         uuid NOT NULL,
  last_run_id          uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((check_name = 'fuel_duplicate') = (other_purchase_id IS NOT NULL)),
  CHECK (other_purchase_id IS DISTINCT FROM fuel_purchase_id),
  CHECK ((check_name = 'fuel_over_tank') = (excess_cents IS NOT NULL)),
  CHECK ((suggested_cents IS NULL) = (no_suggestion IS NOT NULL)),
  CHECK ((status = 'dismissed') = (dismiss_category IS NOT NULL)),
  CHECK ((status = 'proposed') = (proposal_id IS NOT NULL)),
  CHECK (compare_verdict IS NULL OR check_name = 'fuel_duplicate'),
  CHECK (COALESCE(compare_verdict IN ('same', 'different'), false) = (compare_confidence IS NOT NULL)),
  CHECK (COALESCE(compare_verdict = 'unknown', false) = (compare_category IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, finding_key),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, fuel_purchase_id) REFERENCES fuel_purchases (tenant_id, id),
  FOREIGN KEY (tenant_id, other_purchase_id) REFERENCES fuel_purchases (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_item_id) REFERENCES pay_items (tenant_id, id),
  FOREIGN KEY (tenant_id, compare_call_id) REFERENCES model_calls (tenant_id, id)
    ON DELETE SET NULL (compare_call_id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id),
  FOREIGN KEY (tenant_id, first_run_id) REFERENCES fuel_check_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, last_run_id) REFERENCES fuel_check_runs (tenant_id, id)
);
CREATE INDEX fuel_findings_tenant_status ON fuel_findings (tenant_id, status, purchased_on DESC);

-- A new finding is open and undecided. Its identity never changes. Status moves only
--   open -> proposed (with its card) | dismissed (with a reason) | cleared (no longer found)
--   proposed -> open (its card was rejected, expired or failed; the card is let go)
--   cleared -> open (found again)
-- and a dismissed finding stays dismissed. A final compare answer never changes; only the
-- model call row it names may go (ON DELETE SET NULL).
CREATE FUNCTION fuel_findings_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open'
       OR NEW.proposal_id IS NOT NULL
       OR NEW.dismiss_category IS NOT NULL
       OR NEW.compare_verdict IS NOT NULL
       OR NEW.compare_call_id IS NOT NULL
       OR NEW.compare_document_ids IS DISTINCT FROM CAST('[]' AS jsonb)
       OR NEW.first_run_id IS DISTINCT FROM NEW.last_run_id THEN
      RAISE EXCEPTION 'fuel_findings: a new finding must be open and undecided'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.finding_key IS DISTINCT FROM OLD.finding_key
     OR NEW.check_name IS DISTINCT FROM OLD.check_name
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.fuel_purchase_id IS DISTINCT FROM OLD.fuel_purchase_id
     OR NEW.other_purchase_id IS DISTINCT FROM OLD.other_purchase_id
     OR NEW.first_run_id IS DISTINCT FROM OLD.first_run_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'fuel_findings: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('proposed', 'dismissed', 'cleared'))
    OR (OLD.status = 'proposed' AND NEW.status = 'open')
    OR (OLD.status = 'cleared' AND NEW.status = 'open')) THEN
    RAISE EXCEPTION 'fuel_findings: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dismiss_category IS DISTINCT FROM OLD.dismiss_category
     AND NOT (OLD.status = 'open' AND NEW.status = 'dismissed') THEN
    RAISE EXCEPTION 'fuel_findings: a dismissal never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     AND NOT (OLD.status = 'open' AND NEW.status = 'proposed')
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'open') THEN
    RAISE EXCEPTION 'fuel_findings: a finding names its card only when proposed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.compare_verdict IN ('same', 'different') OR OLD.compare_category = 'unreadable') AND (
       NEW.compare_verdict IS DISTINCT FROM OLD.compare_verdict
    OR NEW.compare_confidence IS DISTINCT FROM OLD.compare_confidence
    OR NEW.compare_category IS DISTINCT FROM OLD.compare_category
    OR NEW.compare_document_ids IS DISTINCT FROM OLD.compare_document_ids
    OR (NEW.compare_call_id IS DISTINCT FROM OLD.compare_call_id AND NEW.compare_call_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'fuel_findings: a compare answer never changes once kept'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fuel_findings_guard
  BEFORE INSERT OR UPDATE ON fuel_findings
  FOR EACH ROW EXECUTE FUNCTION fuel_findings_guard();

ALTER TABLE fuel_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fuel_findings
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON fuel_findings TO payday_app;
GRANT UPDATE (load_id, pay_item_id, purchased_on, state, gallons_milli, tank_gallons, paid_with,
              amount_cents, excess_cents, suggested_cents, no_suggestion, sources, status,
              dismiss_category, compare_verdict, compare_confidence, compare_category,
              compare_call_id, compare_document_ids, proposal_id, last_run_id, updated_at)
  ON fuel_findings TO payday_app;
