-- STUB SENT (0086): a staff member records that they sent a driver's paid paystub to the driver,
-- when (stub_sent_at) and who (stub_sent_by, their membership). Nothing here sends anything: the
-- mark is a person's statement of fact, made by a click on the paystub's record page
-- (POST /api/settlements/[id]/stub-sent, src/lib/settlements/stub-sent.ts). The agent reads the
-- mark and names the person by role only, never by membership id or email.
--
-- 1. stub_sent_at, stub_sent_by: set together or not at all (settlements_stub_sent_pair).
-- 2. stub_sent_by names a membership of the same carrier (settlements_stub_sent_by_fk; every
--    reference carries tenant_id, as 0084's do).
-- 3. Only a paid paystub with its paid time can be marked, and never before it was paid
--    (settlements_stub_sent_paid; a null paid_at fails it outright rather than passing the compare).
--
-- Additive and nullable: every row already there has nulls in both columns, so no row is changed
-- and none needs narrowing. Each constraint is added NOT VALID and checked by
-- 0086_stub_sent_validate.sql, which the runner applies next in its own transaction. No grant
-- changes: the app role already has UPDATE on settlements (0005). No undo: a wrong mark is a later
-- item, never a delete.

ALTER TABLE settlements ADD COLUMN stub_sent_at timestamptz;
ALTER TABLE settlements ADD COLUMN stub_sent_by uuid;
ALTER TABLE settlements ADD CONSTRAINT settlements_stub_sent_by_fk
  FOREIGN KEY (tenant_id, stub_sent_by) REFERENCES memberships (tenant_id, id) NOT VALID;
ALTER TABLE settlements ADD CONSTRAINT settlements_stub_sent_pair
  CHECK ((stub_sent_at IS NULL) = (stub_sent_by IS NULL)) NOT VALID;
ALTER TABLE settlements ADD CONSTRAINT settlements_stub_sent_paid
  CHECK (stub_sent_at IS NULL OR (status = 'paid' AND paid_at IS NOT NULL AND stub_sent_at >= paid_at)) NOT VALID;
