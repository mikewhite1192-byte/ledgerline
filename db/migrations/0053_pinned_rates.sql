-- Pinned fuel and tax rates: the weekly diesel price a carrier's fuel surcharge follows and each
-- state's fuel tax rate, each one a person's choice from a linked source. A person presses "Look
-- up"; a web search suggests a figure with the page it came from (a 'suggested' row, or an
-- 'unconfirmed' one when the figure could not be matched to a page the search returned). Only an
-- admin pins: a pinned row is the only kind anything may read as a rate, and it never changes; a
-- correction is a new pin, which retires the one before it. Nothing here recalculates, bills or
-- pays anything; the agent reads pins and never writes this table.
--
-- Additive only. Not in demo_reset_clear(): the table is a seeded table (the seed pins nothing),
-- so the seed's replace empties it through the app role's DELETE.
--
--   value_mcents    thousandths of a cent per gallon: $3.657 is 365,700, a $0.2850 rate 28,500
--   source_url      the page the figure was matched to, or the page a person typed it from
--   quote           the page text the figure was matched in (at most 300 characters)
--   as_of           a date read from that text, when it carries one
--   effective_from  the tenant-local day a pinned rate applies from
--   lookup_call_id  the model_calls row of the lookup that suggested it
CREATE TABLE pinned_rates (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('diesel_index', 'ifta_rate')),
  state          text CHECK (state ~ '^[A-Z]{2}$'),
  status         text NOT NULL CHECK (status IN ('suggested', 'unconfirmed', 'pinned')),
  value_mcents   bigint CHECK (value_mcents BETWEEN 1 AND 100000000),
  source         text NOT NULL CHECK (source IN ('lookup', 'typed')),
  source_url     text NOT NULL CHECK (source_url ~ '^https://' AND length(source_url) <= 2000),
  source_title   text CHECK (length(source_title) <= 200),
  quote          text CHECK (length(quote) <= 300),
  as_of          date,
  effective_from date,
  lookup_call_id uuid,
  trace_id       uuid,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  pinned_by      uuid,
  pinned_at      timestamptz,
  retired_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id),
  FOREIGN KEY (tenant_id, pinned_by) REFERENCES memberships (tenant_id, id),
  -- A state's fuel tax rate names its state; the diesel price is national.
  CHECK ((kind = 'ifta_rate') = (state IS NOT NULL)),
  CHECK ((status = 'pinned') = (pinned_by IS NOT NULL AND pinned_at IS NOT NULL
                                AND effective_from IS NOT NULL AND value_mcents IS NOT NULL)),
  -- An unconfirmed suggestion carries no figure; a suggested one always does.
  CHECK (status <> 'unconfirmed' OR value_mcents IS NULL),
  CHECK (status <> 'suggested' OR value_mcents IS NOT NULL),
  -- A lookup row names its model call; a typed rate is pinned as it is written.
  CHECK ((source = 'lookup') = (lookup_call_id IS NOT NULL)),
  CHECK (source = 'lookup' OR status = 'pinned'),
  -- Only a pin is ever retired.
  CHECK (retired_at IS NULL OR status = 'pinned')
);
-- One live pin per carrier, kind and state: a new pin retires the one before it in the same
-- transaction, under the carrier's rate_pin lock.
CREATE UNIQUE INDEX pinned_rates_one_live ON pinned_rates (tenant_id, kind, COALESCE(state, '--'))
  WHERE status = 'pinned' AND retired_at IS NULL;
CREATE INDEX pinned_rates_lookup ON pinned_rates (tenant_id, kind, state, created_at DESC);

-- What may change: a suggestion becomes a pin (status, pinned_by, pinned_at, effective_from, once),
-- and a pin is retired (retired_at, once). Nothing else ever does, on any row.
CREATE FUNCTION pinned_rates_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.value_mcents IS DISTINCT FROM OLD.value_mcents
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.source_url IS DISTINCT FROM OLD.source_url
     OR NEW.source_title IS DISTINCT FROM OLD.source_title
     OR NEW.quote IS DISTINCT FROM OLD.quote
     OR NEW.as_of IS DISTINCT FROM OLD.as_of
     OR NEW.lookup_call_id IS DISTINCT FROM OLD.lookup_call_id
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pinned_rates: a rate and its source never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'pinned' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by
       OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR OLD.retired_at IS NOT NULL
       OR NEW.retired_at IS NULL THEN
      RAISE EXCEPTION 'pinned_rates: a pin is only ever retired, once' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'suggested' THEN
    IF NEW.status <> 'pinned' THEN
      RAISE EXCEPTION 'pinned_rates: a suggestion only becomes a pin' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'pinned_rates: an unconfirmed suggestion never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pinned_rates_guard BEFORE UPDATE ON pinned_rates
  FOR EACH ROW EXECUTE FUNCTION pinned_rates_guard();

ALTER TABLE pinned_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pinned_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pinned_rates
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- DELETE is for the seed's replace only (the seed pins nothing); the app never deletes a rate.
GRANT SELECT, INSERT, DELETE ON pinned_rates TO payday_app;
GRANT UPDATE (status, effective_from, pinned_by, pinned_at, retired_at) ON pinned_rates TO payday_app;
