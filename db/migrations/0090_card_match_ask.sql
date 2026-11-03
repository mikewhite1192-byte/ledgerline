-- CARD MATCH ASKS (0090): Auto is no longer offered on a card match (src/lib/autopilot/rules-admin.ts,
-- autoOffered: the engine never recomputes one, so the autopilot cannot check it), and the starting
-- rules write it as Ask me (src/lib/autopilot/defaults.ts). 0070 wrote it as Auto for the two
-- invented demo carriers and the demo reset keeps autopilot_rules, so a stored Auto rule would show
-- a mode the page no longer offers and refuse a save of its limits alone.
--
-- 1. A card match rule set to Auto is narrowed to Ask me, its version moving up by exactly one
--    through autopilot_rules_guard (0074's definition: a change to the mode moves the version by
--    one) and updated_by 'setup', so the rule an approval names is always the one in force. Its
--    limits stay as they were. Nothing is approved or undone: a proposal the autopilot already
--    decided keeps its record. The UPDATE takes only row locks on the rules it changes.
--
-- No autopilot_changes row is written: that record (0089) holds the changes a person makes from
-- the app, and this one is the setup's, as 0074's and 0077's narrowing were. Only rules still on
-- Auto match, so a second run changes nothing, and a fresh database has no rule to change. No row
-- is dropped; this file only narrows.

-- 1. Card match rules on Auto: Ask me, version up by one.
UPDATE autopilot_rules
   SET mode = 'ask', version = version + 1, updated_by = 'setup', updated_at = now()
 WHERE kind = 'card_match' AND mode = 'auto';
