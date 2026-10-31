-- Narrows the rules that break the check 0077_never_alone.sql added NOT VALID, then validates it
-- against the rows that were already there. The runner applies this file right after that one, in
-- its own transaction, so 0077's ADD CONSTRAINT lock is gone by now. From 0077's commit on the
-- check refused every new Auto rule on a kind off the allowlist, so the rows this file narrows are
-- the only ones that can break it, and no new one can appear between the two files.
--
-- 1. A rule a carrier set to Auto on any other kind before 0077 (0070 allowed it) is narrowed to
--    Ask me, its version moving up by exactly one through autopilot_rules_guard (0074's
--    definition: a change to the mode moves the version by one) and updated_by 'never_alone', so
--    the rule an approval names is always the one in force. Its limits stay as they were. Nothing
--    is approved or undone: a proposal the autopilot already decided keeps its record. The UPDATE
--    takes only row locks on the rules it changes.
-- 2. VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which lets reads and writes go on.
--    After step 1 no row can break autopilot_rules_auto_allowlist.
--
-- No row is dropped; step 1 only narrows.

-- 1. Rules set to Auto on a never-alone kind before 0077: Ask me, version up by one.
UPDATE autopilot_rules
   SET mode = 'ask', version = version + 1, updated_by = 'never_alone', updated_at = now()
 WHERE mode = 'auto'
   AND kind NOT IN ('invoice_post', 'card_match', 'payment_reapply', 'advance_payout', 'money_code');

-- 2. Validate.
ALTER TABLE autopilot_rules VALIDATE CONSTRAINT autopilot_rules_auto_allowlist;
