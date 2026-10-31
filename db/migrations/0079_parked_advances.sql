-- PARKED ADVANCES (0079): a person's approval of an advance whose numbers no longer hold when it
-- runs (the card is gone, the card statement names someone else, no room is left, or the approval
-- went over an auditor block or an engine mismatch) parks the advance with its reason, instead of
-- failing the proposal, while the switch is on (src/lib/advances/approve.ts). A person approves it
-- again to pay it (the advance keeps its id, so its payout keeps the ledger key it would have had)
-- or rejects it (src/lib/proposals/reject.ts). A parked advance never has a ledger row, and the
-- autopilot never parks, releases or approves one.
--
-- 1. park_reason and parked_at, both null on every row already there. park_reason is one of the
--    four codes; parked_at says when the latest park was. A release keeps both as history.
-- 2. advances_status_check (0005's inline check, by its default name), the same five statuses in
--    the same order plus parked. Added NOT VALID.
-- 3. Three checks, each NOT VALID: the reason and its time are set together; a parked advance
--    always has its reason; only a flow advance (one with a proposal, never seeded) can be parked.
--
-- Every check here is added NOT VALID, so this file reads and changes no rows while it holds the
-- ALTER TABLE lock, and that lock is gone once this file's transaction commits. A NOT VALID check
-- is still enforced on every insert and update from that commit on.
-- 0079_parked_advances_validate.sql, which the runner applies right after this one in its own
-- transaction, validates all four against the rows already there.
--
-- No row is dropped or changed here. Grants (0005's table-level UPDATE covers the new columns),
-- row security and demo_reset_clear() (it deletes every flow advance, parked ones with them) are
-- unchanged.

-- 1. The reason and its time.
ALTER TABLE advances
  ADD COLUMN park_reason text,
  ADD COLUMN parked_at timestamptz;
ALTER TABLE advances
  ADD CONSTRAINT advances_park_reason_check CHECK (
    park_reason IS NULL OR park_reason IN ('name_mismatch', 'override', 'no_room', 'card_removed')) NOT VALID;

-- 2. The statuses, plus parked.
ALTER TABLE advances DROP CONSTRAINT advances_status_check;
ALTER TABLE advances
  ADD CONSTRAINT advances_status_check CHECK (
    status IN ('requested', 'approved', 'paid', 'rejected', 'cancelled', 'parked')) NOT VALID;

-- 3. A parked advance: its reason with its time, only on a flow advance.
ALTER TABLE advances
  ADD CONSTRAINT advances_parked_pair CHECK ((park_reason IS NULL) = (parked_at IS NULL)) NOT VALID;
ALTER TABLE advances
  ADD CONSTRAINT advances_parked_reason CHECK (status <> 'parked' OR park_reason IS NOT NULL) NOT VALID;
ALTER TABLE advances
  ADD CONSTRAINT advances_parked_flow CHECK (
    status <> 'parked' OR (proposal_id IS NOT NULL AND source <> 'seed')) NOT VALID;
