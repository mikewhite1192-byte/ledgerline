-- NAMED STUB LINES (0084): who typed a pay line and which record it claims to match. A staff
-- member may put one reimbursement or deduction on a driver's draft paystub that cites one real
-- record, a fuel purchase or a load accessorial (src/lib/settlements/named-line.ts). It is written
-- as a pay item, so the rules engine makes the line and the totals as for every other item; the pay
-- run copies the person and the record onto the line, and the pre-pay recheck compares the line
-- with that record before any approval (src/lib/settlements/contradiction.ts).
--
-- 1. pay_items.entered_by: the person who typed the item (a membership), null for every item the
--    engine, the sweep, a money code or an approved correction wrote. A typed item always names
--    its record: ref_table is fuel_purchases or load_accessorials (ref_id goes with it by 0005's
--    pairing).
-- 2. settlement_lines.entered_by and source_ref: copied from the pay item by the pay run, so the
--    stub, the agent and the approval check read the person and the record off the line itself.
--    source_ref is '<table>:<uuid>', the whole value, the same two tables; the two columns are
--    set together or not at all.
--
-- Additive and nullable: every row already there has nulls in the new columns, so no row is
-- changed and none needs narrowing. Every reference carries tenant_id. Each constraint is added NOT
-- VALID and checked by 0084_named_lines_validate.sql, which the runner applies next in its own
-- transaction. No grant changes: the app role already has INSERT and UPDATE on both tables (0005).

ALTER TABLE pay_items ADD COLUMN entered_by uuid;
ALTER TABLE pay_items ADD CONSTRAINT pay_items_entered_by_fk
  FOREIGN KEY (tenant_id, entered_by) REFERENCES memberships (tenant_id, id) NOT VALID;
ALTER TABLE pay_items ADD CONSTRAINT pay_items_named_has_ref
  CHECK (entered_by IS NULL OR (ref_table IS NOT NULL AND ref_table IN ('fuel_purchases', 'load_accessorials')))
  NOT VALID;

ALTER TABLE settlement_lines ADD COLUMN entered_by uuid;
ALTER TABLE settlement_lines ADD COLUMN source_ref text;
ALTER TABLE settlement_lines ADD CONSTRAINT settlement_lines_entered_by_fk
  FOREIGN KEY (tenant_id, entered_by) REFERENCES memberships (tenant_id, id) NOT VALID;
ALTER TABLE settlement_lines ADD CONSTRAINT settlement_lines_source_ref_form
  CHECK (source_ref IS NULL OR source_ref ~ '^(fuel_purchases|load_accessorials):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') NOT VALID;
ALTER TABLE settlement_lines ADD CONSTRAINT settlement_lines_named_pair
  CHECK ((entered_by IS NULL) = (source_ref IS NULL)) NOT VALID;
