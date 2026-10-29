-- Pay cards: a picture of one driver's week (take-home pay, what was earned and taken out, loads,
-- the change from last week) that a clerk saves and sends from their own phone. The rules engine
-- already computed every figure on the settlement; the card only prints them. Before a card can be
-- saved, Muse Spark reads the picture back and code compares what it read with the settlement's own
-- figures, whole values only. A card that does not match is never stored as an image.
--
-- Read-only on settlements: nothing here changes a settlement, a pay line or a payout.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Every reference to another tenant table is a
-- composite foreign key on (tenant_id, x_id). It is a seeded table (TENANT_TABLES, none planted),
-- so the seed's replace and the demo reset delete its rows as the app role: DELETE is granted for
-- that, and nothing in the app deletes a card.
--
-- status:
--   checking     reserved before the model call; no image kept
--   checked      the read-back matched every figure; the image bytes are kept (only now)
--   mismatch     the read-back differed; no image kept, what the model read is kept in check_read
--   unavailable  the model call failed or timed out; category says which; the attempt is used
--
-- At most three attempts per settlement: attempt is 1 to 3 and (tenant, settlement, attempt) is
-- unique, so a fourth insert is refused by the table itself and a second click racing the first
-- for the same attempt number is refused by the key. spec is what the server computed from the
-- settlement when it checked (the card's printed figures and words); it never changes. trace_id
-- groups one run of the cards page, so its spend can be summed from model_calls.
CREATE TABLE pay_cards (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  attempt       smallint NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  status        text NOT NULL CHECK (status IN ('checking', 'checked', 'mismatch', 'unavailable')),
  art           text NOT NULL CHECK (art ~ '^art-0[1-9]$'),
  spec          jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  check_read    jsonb CHECK (jsonb_typeof(check_read) = 'object'),
  category      text CHECK (category IN ('number_mismatch', 'text_mismatch', 'off_schema', 'timeout', 'budget', 'unknown')),
  mime          text CHECK (mime IN ('image/png')),
  byte_length   integer CHECK (byte_length BETWEEN 1 AND 400000),
  bytes         bytea CHECK (bytes IS NULL OR octet_length(bytes) = byte_length),
  content_hash  text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  check_call_id uuid,
  trace_id      uuid NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  checked_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, settlement_id, attempt),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES settlements (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id),
  -- Null until the call is made, and left null when it never was.
  FOREIGN KEY (tenant_id, check_call_id) REFERENCES model_calls (tenant_id, id),
  -- The image exists exactly when the card passed the check, with its type, size and hash.
  CHECK ((status = 'checked') = (bytes IS NOT NULL)),
  CHECK ((bytes IS NULL) = (mime IS NULL)),
  CHECK ((bytes IS NULL) = (byte_length IS NULL)),
  CHECK ((bytes IS NULL) = (content_hash IS NULL)),
  -- A failed card always says why; a passed or pending one never does.
  CHECK ((status IN ('mismatch', 'unavailable')) = (category IS NOT NULL)),
  -- Finished means a time; pending means none.
  CHECK ((status = 'checking') = (checked_at IS NULL))
);

CREATE INDEX pay_cards_settlement ON pay_cards (tenant_id, settlement_id, attempt DESC);
CREATE INDEX pay_cards_created ON pay_cards (tenant_id, created_at);

-- What a card may become, and what never changes. A new row is only ever a bare reservation
-- (checking, with its spec and nothing read or kept). It is finished once, on the step out of
-- checking; a finished card is final. The settlement, attempt, art, spec, run and who asked never
-- change.
CREATE FUNCTION pay_cards_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'checking'
       OR NEW.check_read IS NOT NULL
       OR NEW.category IS NOT NULL
       OR NEW.bytes IS NOT NULL
       OR NEW.check_call_id IS NOT NULL
       OR NEW.checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'pay_cards: a new card must be a bare reservation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.art IS DISTINCT FROM OLD.art
     OR NEW.spec IS DISTINCT FROM OLD.spec
     OR NEW.trace_id IS DISTINCT FROM OLD.trace_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pay_cards: identity and figures never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'checking' THEN
    RAISE EXCEPTION 'pay_cards: a finished card never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pay_cards_guard
  BEFORE INSERT OR UPDATE ON pay_cards
  FOR EACH ROW EXECUTE FUNCTION pay_cards_guard();

ALTER TABLE pay_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_cards
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, DELETE ON pay_cards TO payday_app;
GRANT UPDATE (status, check_read, category, mime, byte_length, bytes, content_hash, check_call_id, checked_at)
  ON pay_cards TO payday_app;
