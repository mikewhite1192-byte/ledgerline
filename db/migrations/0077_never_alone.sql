-- NEVER ALONE (0077): the kinds a named person always approves can never be set to Auto, in the
-- database as well as in code (src/lib/money/never-alone.ts). The owner may set Auto only on the
-- six kinds of AUTO_ALLOWED_KINDS there: invoice_post, card_match and payment_reapply (nothing
-- leaves the company), advance_payout and money_code (inside the owner's per-driver day, 0074),
-- and load_move (no money). Every other kind (settlement_approve, escrow_release, pay_correction,
-- pay_rule_change and the rest) stays Ask me or Off.
--
-- 1. autopilot_rules_auto_allowlist: mode <> 'auto' OR kind IN (the six). Added NOT VALID, so this
--    file reads no rows under its lock, and validated by 0077_never_alone_validate.sql, which the
--    runner applies right after this one.
-- 2. A rule a carrier already set to Auto on any other kind (0070 allowed it) is narrowed to Ask
--    me, its version moving up by exactly one through autopilot_rules_guard (0074's definition:
--    a change to the mode moves the version by one) and updated_by 'never_alone', so the rule an
--    approval names is always the one in force. Its limits stay as they were. Nothing is approved
--    or undone: a proposal the autopilot already decided keeps its record.
--
-- No row is dropped; step 2 only narrows. The kind check, the guard and every other check are
-- unchanged.

-- 1. Auto only on the allowlist.
ALTER TABLE autopilot_rules
  ADD CONSTRAINT autopilot_rules_auto_allowlist CHECK (
    mode <> 'auto'
    OR kind IN ('invoice_post', 'card_match', 'payment_reapply', 'advance_payout', 'money_code', 'load_move')) NOT VALID;

-- 2. Rules set to Auto on a never-alone kind before this file: Ask me, version up by one.
UPDATE autopilot_rules
   SET mode = 'ask', version = version + 1, updated_by = 'never_alone', updated_at = now()
 WHERE mode = 'auto'
   AND kind NOT IN ('invoice_post', 'card_match', 'payment_reapply', 'advance_payout', 'money_code', 'load_move');
