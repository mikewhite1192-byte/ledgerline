-- Collections: a short reminder email for an invoice 30 or more days past due. Code picks the
-- invoices, the stage (30, 60 or 90 days) and the tone from how the customer has paid; Muse Spark
-- writes the words from the invoice's own figures; code checks every number in the reminder
-- against them before a person sees it; a person approves or rejects it. Approving records the
-- reminder; an email goes only when sending is switched on for that exact address. Nothing here
-- moves money, changes an invoice or posts to accounting.
--
-- The customer's billing address (customers.billing_email) already exists: migration 0028 added it
-- with a check that it is lower case and ends in .example, so this migration adds no column there.
--
-- The table follows db/README.md: tenant_id with ON DELETE CASCADE, ENABLE and FORCE row-level
-- security and the one tenant_isolation policy. Ids are made by the app. Every reference to
-- another tenant table is a composite foreign key on (tenant_id, x_id).
--
-- Rows hold ids, enums, cents, whole days, dates and categories. The only text is the reminder
-- itself (subject and body), and only once it passed the check: a draft that failed keeps no text,
-- only the category and the amounts the check compared. No prompt, model output that failed, or
-- upstream error is stored.

-- One reminder per invoice and stage. The row is written (drafting) before the model call, so a
-- second click or a crash never makes a second reminder: UNIQUE (tenant_id, invoice_id, stage) is
-- the dedupe key. A later stage of the same invoice is a new reminder.
--
-- status:
--   drafting  reserved before the model call; no text yet
--   drafted   the reminder passed the check and waits for a person
--   refused   the check or the model call failed, or the invoice reached a later stage while the
--             reminder was still waiting (stage_passed); no text, refusal_category says why
--   over_cap  not drafted, waiting for the next run: the run's spend reached its cap, the model
--             call was turned down before any request went out (no call was made), or a run was cut
--             off mid-draft (the next run's lease puts it back here)
--   approved  a person approved it; recorded (channel 'logged'), and emailed only when allowed
--   rejected  a person rejected it
--
-- figures holds what the reminder was written from, as numbers and dates (cents, whole days, the
-- invoice number), so the page and the approval check never re-derive them from the text.
-- trace_id is the run that drafts the reminder (one trace id per run): its model calls carry it in
-- model_calls, and the run cap sums them by it. A reminder picked up again from over_cap takes the
-- new run's trace id, figures and tone, so it is always written from that day's numbers.
-- model_call_id names the call whose answer was checked. verification holds the amounts the check
-- allowed and found, in cents, and the category.
CREATE TABLE collection_drafts (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id       uuid NOT NULL,
  customer_id      uuid NOT NULL,
  stage            text NOT NULL CHECK (stage IN ('30', '60', '90')),
  tone             text NOT NULL CHECK (tone IN ('friendly', 'direct', 'firm')),
  status           text NOT NULL
                   CHECK (status IN ('drafting', 'drafted', 'refused', 'over_cap', 'approved', 'rejected')),
  figures          jsonb NOT NULL CHECK (jsonb_typeof(figures) = 'object'),
  subject          text CHECK (char_length(subject) BETWEEN 1 AND 120),
  body             text CHECK (char_length(body) BETWEEN 1 AND 1500),
  refusal_category text CHECK (refusal_category ~ '^[a-z_]{2,40}$'),
  verification     jsonb CHECK (jsonb_typeof(verification) = 'object'),
  trace_id         uuid NOT NULL,
  model_call_id    uuid,
  decided_by       text CHECK (char_length(decided_by) BETWEEN 1 AND 128),
  decided_at       timestamptz,
  channel          text CHECK (channel IN ('logged', 'email')),
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Text exists exactly when the reminder passed the check, and comes as a pair.
  CHECK ((status IN ('drafted', 'approved', 'rejected')) = (subject IS NOT NULL)),
  CHECK ((subject IS NULL) = (body IS NULL)),
  CHECK ((status = 'refused') = (refusal_category IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  -- An approved reminder is recorded at approval; nothing else ever is.
  CHECK ((channel IS NOT NULL) = (status = 'approved')),
  -- A send time exists only on a reminder reserved for email.
  CHECK (sent_at IS NULL OR channel = 'email'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, stage),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  -- Null until the call is made, and left null when it never was. model_calls carries
  -- UNIQUE (tenant_id, id) since 0019.
  FOREIGN KEY (tenant_id, model_call_id) REFERENCES model_calls (tenant_id, id)
);
CREATE INDEX collection_drafts_tenant_status ON collection_drafts (tenant_id, status);

-- What a reminder may become, and what never changes. The text and the check's record are written
-- once, on the step out of drafting, and never again: approval never edits the text. The invoice,
-- customer and stage never change. The figures, tone and run (trace_id) change only when a waiting
-- reminder is picked up again (over_cap to drafting), before any text exists. Status moves forward
-- only. over_cap may go back to drafting (the next run picks it up), and drafting may go back to
-- over_cap while the reminder names no model call (its call was turned down before any request went
-- out, or the run was cut off and the lease ran out). A waiting reminder whose invoice has since
-- reached a later stage is closed as refused with stage_passed, naming no model call, and nothing
-- else changes on that step. refused, rejected and approved are final. The channel is set to
-- 'logged' at approval and may move to 'email' once, when an allowlisted email is reserved (before
-- the send); sent_at is written once, after the send went out, on a reminder already reserved for
-- email. A new row is only ever a bare reservation (drafting, or over_cap with no call made): no
-- text, check record, refusal, model call, decision or channel, so every later state goes through
-- the update rules and nothing can be inserted already approved.
CREATE FUNCTION collection_drafts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('drafting', 'over_cap')
       OR NEW.subject IS NOT NULL
       OR NEW.body IS NOT NULL
       OR NEW.verification IS NOT NULL
       OR NEW.refusal_category IS NOT NULL
       OR NEW.model_call_id IS NOT NULL
       OR NEW.decided_by IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.channel IS NOT NULL
       OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'collection_drafts: a new reminder must be a bare reservation'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.stage IS DISTINCT FROM OLD.stage
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'collection_drafts: identity never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.trace_id IS DISTINCT FROM OLD.trace_id
      OR NEW.figures IS DISTINCT FROM OLD.figures
      OR NEW.tone IS DISTINCT FROM OLD.tone)
     AND NOT (OLD.status = 'over_cap' AND NEW.status = 'drafting') THEN
    RAISE EXCEPTION 'collection_drafts: figures change only when a waiting reminder is picked up again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused'))
    OR (OLD.status = 'over_cap' AND NEW.status = 'drafting')
    OR (OLD.status = 'drafting' AND NEW.status = 'over_cap'
        AND OLD.model_call_id IS NULL AND NEW.model_call_id IS NULL)
    OR (OLD.status = 'over_cap' AND NEW.status = 'refused'
        AND NEW.refusal_category IS NOT DISTINCT FROM 'stage_passed'
        AND OLD.model_call_id IS NULL AND NEW.model_call_id IS NULL)
    OR (OLD.status = 'drafted' AND NEW.status IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'collection_drafts: status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status = 'drafting' AND NEW.status IN ('drafted', 'refused'))
     AND (NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.verification IS DISTINCT FROM OLD.verification
       OR (NEW.refusal_category IS DISTINCT FROM OLD.refusal_category
           AND NOT (OLD.status = 'over_cap' AND NEW.status = 'refused'))
       OR NEW.model_call_id IS DISTINCT FROM OLD.model_call_id) THEN
    RAISE EXCEPTION 'collection_drafts: the text of a reminder never changes once written'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.status = 'drafted' AND NEW.status IN ('approved', 'rejected'))
     AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'collection_drafts: a decision never changes once made' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel IS DISTINCT FROM OLD.channel
     AND NOT (OLD.status = 'drafted' AND NEW.status = 'approved' AND NEW.channel = 'logged')
     AND NOT (OLD.status = 'approved' AND NEW.status = 'approved'
              AND OLD.channel = 'logged' AND NEW.channel = 'email') THEN
    RAISE EXCEPTION 'collection_drafts: channel change not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sent_at IS DISTINCT FROM OLD.sent_at
     AND NOT (OLD.status = 'approved' AND NEW.status = 'approved'
              AND OLD.channel = 'email' AND NEW.channel = 'email'
              AND OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL) THEN
    RAISE EXCEPTION 'collection_drafts: a send time is written once, after the email reservation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_drafts_guard
  BEFORE INSERT OR UPDATE ON collection_drafts
  FOR EACH ROW EXECUTE FUNCTION collection_drafts_guard();

ALTER TABLE collection_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collection_drafts
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- DELETE only because the table is one the seed's replace rewrites (TENANT_TABLES): the replace
-- deletes the carrier's reminders before the invoices they name. The app never deletes a reminder.
GRANT SELECT, INSERT, DELETE ON collection_drafts TO payday_app;
GRANT UPDATE (status, tone, figures, subject, body, refusal_category, verification, trace_id,
              model_call_id, decided_by, decided_at, channel, sent_at, updated_at)
  ON collection_drafts TO payday_app;
