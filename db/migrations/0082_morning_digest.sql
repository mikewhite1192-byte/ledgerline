-- MORNING DIGEST (0082): each carrier's morning line from the desk (src/lib/digest). At 06:00
-- local the desk reads about ten facts from SQL, Muse Spark words them into one line of at most
-- 400 characters with every number checked against the facts, and the line shows in the agent's
-- ask card as a told line the person closes with Got it. A model that fails, or a number the check
-- refuses, lands the same facts as a line written by code instead. The digest is about the carrier,
-- not a proposal, so it is a third kind of agent_asks row with no proposal and with the local date
-- it covers.
--
-- 1. desk_log_source_check: 0075's twelve sources whole, plus digest (the period source
--    digest:YYYY-MM-DD). NOT VALID.
-- 2. agent_asks.proposal_id may be null: a digest names no proposal. The composite foreign key
--    to proposals skips a row whose proposal_id is null by itself, and every ask and told line
--    still names one (check 5).
-- 3. agent_asks.period_date: the carrier's local date a digest is for; null on every other row,
--    and on every row already there. Never updated (the app's UPDATE grant on agent_asks lists its
--    columns, 0072, and this one is not among them).
-- 4. agent_asks_kind_check (0072's column check, by its default name): ask, told, digest. NOT VALID.
-- 5. agent_asks_digest_shape: a digest and only a digest has no proposal, and a digest and only a
--    digest has a period date. NOT VALID.
-- 6. agent_asks_check3 (0072's unnamed table check CHECK (kind = 'told' OR status <> 'done'); its
--    default name, read with pg_constraint on a database built from 0001 to 0081): a digest, like
--    a told line, may be done once a person has seen it. NOT VALID. 0072's agent_asks_check4 (an
--    ask may be snoozed or answered, any other kind only open, done or void) already holds a digest
--    to open, done or void, and agent_asks_guard (0072) lets any row move open to done.
-- 7. agent_asks_one_digest: one digest per carrier per local date, the dedupe key.
--
-- Every check here is added NOT VALID, so this file reads and changes no rows while it holds the
-- ALTER TABLE lock, and that lock is gone once this file's transaction commits. A NOT VALID check is
-- still enforced on every insert and update from that commit on. 0082_morning_digest_validate.sql,
-- which the runner applies right after this one in its own transaction, validates all four.
--
-- No row is dropped or changed here. Grants (0072 grants INSERT on the whole table), row security
-- and demo_reset_clear() (it deletes every agent_asks row of the carrier, digests with them, 0080)
-- are unchanged.

-- 1. The desk log's sources: 0075's list whole, plus the morning digest.
ALTER TABLE desk_log DROP CONSTRAINT desk_log_source_check;
ALTER TABLE desk_log ADD CONSTRAINT desk_log_source_check CHECK (source IN (
  'card_transaction', 'inbound_message', 'voice_note', 'customer_payment', 'audit', 'sweep',
  'collections', 'cash_check', 'autopilot', 'document', 'load_event', 'tms_event', 'digest')) NOT VALID;

-- 2. and 3. A digest names no proposal, and names its local date.
ALTER TABLE agent_asks ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE agent_asks ADD COLUMN period_date date;

-- 4. The kinds, plus digest.
ALTER TABLE agent_asks DROP CONSTRAINT agent_asks_kind_check;
ALTER TABLE agent_asks
  ADD CONSTRAINT agent_asks_kind_check CHECK (kind IN ('ask', 'told', 'digest')) NOT VALID;

-- 5. Only a digest has no proposal, and only a digest has a period date.
ALTER TABLE agent_asks
  ADD CONSTRAINT agent_asks_digest_shape CHECK (
    (kind = 'digest') = (proposal_id IS NULL) AND (kind = 'digest') = (period_date IS NOT NULL)) NOT VALID;

-- 6. A digest, like a told line, may be done.
ALTER TABLE agent_asks DROP CONSTRAINT agent_asks_check3;
ALTER TABLE agent_asks
  ADD CONSTRAINT agent_asks_check3 CHECK (kind IN ('told', 'digest') OR status <> 'done') NOT VALID;

-- 7. One digest per carrier per local date.
CREATE UNIQUE INDEX agent_asks_one_digest ON agent_asks (tenant_id, period_date) WHERE kind = 'digest';
