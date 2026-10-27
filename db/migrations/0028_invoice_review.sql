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
--      holds an accounting id with no amount, so the whole migration fails and nothing is applied.
--      None exist while the invoice post switches have never been released.
ALTER TABLE invoices
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by_membership_id uuid,
  ADD COLUMN review_note text CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 240),
  ADD COLUMN sent_on date,
  ADD COLUMN sent_by_membership_id uuid,
  ADD COLUMN qbo_email_status text CHECK (qbo_email_status IN ('not_set', 'need_to_send', 'email_sent')),
  ADD COLUMN qbo_amount_cents bigint CHECK (qbo_amount_cents IS NULL OR qbo_amount_cents > 0),
  ADD CONSTRAINT invoices_reviewed_pair CHECK (reviewed_by_membership_id IS NULL OR reviewed_at IS NOT NULL),
  ADD CONSTRAINT invoices_review_note_needs_review CHECK (review_note IS NULL OR reviewed_at IS NOT NULL),
  ADD CONSTRAINT invoices_sent_pair CHECK (sent_by_membership_id IS NULL OR sent_on IS NOT NULL),
  ADD CONSTRAINT invoices_sent_after_issue CHECK (sent_on IS NULL OR sent_on >= issued_on),
  ADD CONSTRAINT invoices_qbo_pair CHECK (
    (qbo_id IS NULL) = (qbo_amount_cents IS NULL)
    AND (qbo_email_status IS NULL OR qbo_id IS NOT NULL)
  ),
  ADD CONSTRAINT invoices_reviewed_by_fk FOREIGN KEY (tenant_id, reviewed_by_membership_id)
    REFERENCES memberships (tenant_id, id),
  ADD CONSTRAINT invoices_sent_by_fk FOREIGN KEY (tenant_id, sent_by_membership_id)
    REFERENCES memberships (tenant_id, id);

-- 2. Which customers want a signed delivery document with the invoice, and the address the
--    accounting system would email it to. Synthetic addresses only: the .example domain never
--    delivers, and the accounting adapter refuses any other shape before a call.
ALTER TABLE customers
  ADD COLUMN pod_required boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_email text
    CHECK (billing_email IS NULL OR billing_email ~ '^[a-z0-9._-]+@[a-z0-9-]+\.example$');

-- 3. Grants: none needed. 0005 grants payday_app SELECT, INSERT, UPDATE and DELETE on invoices
--    and customers at table level, which covers new columns. memberships already carries
--    UNIQUE (tenant_id, id) from 0006, which the two foreign keys above reference.
