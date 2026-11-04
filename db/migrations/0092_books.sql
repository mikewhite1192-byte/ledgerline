-- BOOKS (0092): every money movement records to the accounting system by itself (D-104). Two new
-- ledger kinds, each one Purchase in the QuickBooks sandbox paid from LedgerLine Clearing to the
-- driver's vendor record:
--      money_code_expense      accounting, subject money_codes (an issued code), counterparty drivers
--      escrow_release_expense  accounting, subject escrow_releases (a released balance), counterparty drivers
-- Additive only. Every CHECK re-created on money_actions, which already has rows, is added NOT VALID
-- and checked by 0092_books_validate.sql, which the runner applies next in its own transaction.
-- No new table, column, grant or account role; demo_reset_clear() is not re-created (it already
-- deletes every settled ledger row of the carrier and refuses while one is open).

-- 1. The kind check: 0080's eleven kinds plus the two above.
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_kind_check;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_kind_check
  CHECK (kind IN ('advance_payout', 'advance_expense', 'settlement_payout', 'settlement_bill',
                  'settlement_bill_payment', 'invoice', 'customer_payment', 'factoring_advance',
                  'money_code_issue', 'escrow_release', 'card_pullback', 'money_code_expense',
                  'escrow_release_expense')) NOT VALID;

-- 2. A money code's subject table holds its issue and its expense, an escrow release's its payout
--    and its expense; no other kind may name either table.
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_money_code_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_money_code_subject_pairing
  CHECK ((kind IN ('money_code_issue', 'money_code_expense')) = (subject_table = 'money_codes')) NOT VALID;
ALTER TABLE money_actions DROP CONSTRAINT IF EXISTS money_actions_escrow_subject_pairing;
ALTER TABLE money_actions ADD CONSTRAINT money_actions_escrow_subject_pairing
  CHECK ((kind IN ('escrow_release', 'escrow_release_expense')) = (subject_table = 'escrow_releases')) NOT VALID;
