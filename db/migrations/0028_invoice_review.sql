-- Invoice review: whether each invoice is ready to send, or what is in the way. The review status
-- itself is never stored: the rules engine computes it every time from the facts below and the
-- records they point at.
--
-- 1. Facts a person made, and what the accounting system said back after a post.
--    reviewed_*: who reviewed the invoice and when. Seeded history is reviewed by construction
--      (reviewed_at set, no member), so a member id never stands without a time.
--    sent_*: the date someone recorded the invoice as sent to the customer. LedgerLine never sends
--      anything; this is an in-app record. Seeded history is sent by construction (no member).
--    qbo_*: the accounting system's send state and amount, read from the reply to the create. The
--      amount is stored whenever an accounting id is; the send state may be missing (a reply that
--      did not carry it is stored null, never guessed), but never without an accounting id.
--      invoices_qbo_pair is checked against existing rows: an invoice posted before this migration
--      holds an accounting id with no amount, so the validation below refuses it. None exist while
--      the invoice post switches have never been released.
--
-- Locks: every check and foreign key here is added NOT VALID, so this file reads no rows and
-- commits at once. Adding the columns takes a brief exclusive lock on invoices and customers, and
-- the foreign keys a brief lock on memberships, but no lock is held through a scan. A NOT VALID
-- constraint holds for every row written from then on; 0028_invoice_review_validate.sql, which the
-- runner applies next in its own transaction, then checks the rows already there under a lock that
-- lets reads and writes go on. Validating in this file would not help: the runner applies each file
-- in one transaction, so the scan would still run under the exclusive lock. The column checks are
-- table constraints only so they can be NOT VALID, and each keeps the name Postgres gives an
-- inline check. An existing row that breaks a rule fails the validation file as it would have
-- failed this one: nothing from that file is kept and the run stops there, every time, until the
-- row is fixed. This file stays applied, and its constraints refuse any new or changed row that
-- breaks them.
ALTER TABLE invoices
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by_membership_id uuid,
  ADD COLUMN review_note text,
  ADD COLUMN sent_on date,
  ADD COLUMN sent_by_membership_id uuid,
  ADD COLUMN qbo_email_status text,
  ADD COLUMN qbo_amount_cents bigint,
  ADD CONSTRAINT invoices_review_note_check
    CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 240) NOT VALID,
  ADD CONSTRAINT invoices_qbo_email_status_check
    CHECK (qbo_email_status IN ('not_set', 'need_to_send', 'email_sent')) NOT VALID,
  ADD CONSTRAINT invoices_qbo_amount_cents_check
    CHECK (qbo_amount_cents IS NULL OR qbo_amount_cents > 0) NOT VALID,
  ADD CONSTRAINT invoices_reviewed_pair
    CHECK (reviewed_by_membership_id IS NULL OR reviewed_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT invoices_review_note_needs_review
    CHECK (review_note IS NULL OR reviewed_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT invoices_sent_pair CHECK (sent_by_membership_id IS NULL OR sent_on IS NOT NULL) NOT VALID,
  ADD CONSTRAINT invoices_sent_after_issue CHECK (sent_on IS NULL OR sent_on >= issued_on) NOT VALID,
  ADD CONSTRAINT invoices_qbo_pair CHECK (
    (qbo_id IS NULL) = (qbo_amount_cents IS NULL)
    AND (qbo_email_status IS NULL OR qbo_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT invoices_reviewed_by_fk FOREIGN KEY (tenant_id, reviewed_by_membership_id)
    REFERENCES memberships (tenant_id, id) NOT VALID,
  ADD CONSTRAINT invoices_sent_by_fk FOREIGN KEY (tenant_id, sent_by_membership_id)
    REFERENCES memberships (tenant_id, id) NOT VALID;

-- 2. Which customers want a signed delivery document with the invoice, and the address the
--    accounting system would email it to. Synthetic addresses only: the .example domain never
--    delivers, and the accounting adapter refuses any other shape before a call. The check is
--    the adapter's own pattern (checkEmail in src/lib/adapters/accounting/qbo/entities.ts), length
--    limits included, so every stored address is one the adapter accepts.
ALTER TABLE customers
  ADD COLUMN pod_required boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_email text,
  ADD CONSTRAINT customers_billing_email_check
    CHECK (billing_email IS NULL OR billing_email ~ '^[a-z0-9._-]{1,64}@[a-z0-9-]{1,63}\.example$') NOT VALID;

-- 3. Grants: none needed. 0005 grants payday_app SELECT, INSERT, UPDATE and DELETE on invoices
--    and customers at table level, which covers new columns. memberships already carries
--    UNIQUE (tenant_id, id) from 0006, which the two foreign keys above reference.
