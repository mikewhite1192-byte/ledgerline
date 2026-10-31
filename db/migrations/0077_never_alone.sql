-- NEVER ALONE (0077): the kinds a named person always approves can never be set to Auto, in the
-- database as well as in code (src/lib/money/never-alone.ts). The owner may set Auto only on the
-- five kinds of AUTO_ALLOWED_KINDS there: invoice_post, card_match and payment_reapply (nothing
-- leaves the company), and advance_payout and money_code (inside the owner's per-driver day,
-- 0074). Every other kind (settlement_approve, escrow_release, pay_correction, pay_rule_change and
-- the rest) stays Ask me or Off.
--
-- This file only adds autopilot_rules_auto_allowlist: mode <> 'auto' OR kind IN (the five). It is
-- added NOT VALID, so this file reads and changes no rows while it holds the ADD CONSTRAINT lock,
-- and that lock is gone once this file's transaction commits. A NOT VALID check is still enforced
-- on every insert and update from that commit on, so no new Auto rule on a kind off the allowlist
-- can appear after it.
--
-- 0077_never_alone_validate.sql, which the runner applies right after this one in its own
-- transaction, narrows the rules a carrier already set to Auto on any other kind (0070 allowed it)
-- to Ask me and then validates the check against the rows already there.
--
-- No row is dropped or changed here. The kind check, the guard and every other check are
-- unchanged.

-- Auto only on the allowlist.
ALTER TABLE autopilot_rules
  ADD CONSTRAINT autopilot_rules_auto_allowlist CHECK (
    mode <> 'auto'
    OR kind IN ('invoice_post', 'card_match', 'payment_reapply', 'advance_payout', 'money_code')) NOT VALID;
