-- Validates the checks and foreign keys 0028_invoice_review.sql added NOT VALID, against the rows
-- that were already there. The runner applies this file right after that one, in its own
-- transaction, so 0028's locks are gone by now. VALIDATE CONSTRAINT scans under SHARE UPDATE
-- EXCLUSIVE on the table (and ROW SHARE on memberships for a foreign key), which lets reads and
-- writes go on. One constraint per statement, so a failure names the statement that broke. A row
-- that breaks a rule fails this file: nothing from it is kept and the run stops here, every time,
-- until the row is fixed.
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_review_note_check;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_qbo_email_status_check;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_qbo_amount_cents_check;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_reviewed_pair;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_review_note_needs_review;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_sent_pair;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_sent_after_issue;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_qbo_pair;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_reviewed_by_fk;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_sent_by_fk;
ALTER TABLE customers VALIDATE CONSTRAINT customers_billing_email_check;
