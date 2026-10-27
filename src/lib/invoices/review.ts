import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { readTenant } from "../data/read";
import { isCanonicalUuid } from "../money/keys";
import { assertMembership } from "../tenant/context";
import { isLocalDate, localDateOf } from "../time/local-date";
import { readInvoiceReview } from "./review-read";

// The two things a person records on an invoice's review: that they reviewed it, and that it was
// sent to the customer. Both are facts in our database only. LedgerLine never sends an invoice or
// an email; "sent" is recorded after a person sent it from the accounting system or by hand. An
// invoice the invoice queue made is posted to accounting before its send is recorded; one from
// earlier records is never posted from here, so its send is recorded with no post. Each write
// happens once: a repeat changes nothing and says so.

export type ReviewRefusal = "disabled" | "validation" | "not_found" | "not_posted" | "not_ready";

export type ReviewWriteResult = { ok: true; changed: boolean } | { ok: false; category: ReviewRefusal };

export const REVIEW_NOTE_MAX = 240;

const isOn = () => flags.invoicesEnabled && flags.invoiceReviewEnabled;
const refuse = (category: ReviewRefusal): ReviewWriteResult => ({ ok: false, category });

// The caller's membership id, which the review columns name.
async function membershipId(q: Queryable, session: Session): Promise<string> {
  await assertMembership(q, session);
  const [m] = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (!m || !isCanonicalUuid(m.id)) throw new Error("membership could not be read");
  return m.id;
}

// A note is optional; given, it is trimmed and 1 to 240 characters with no control characters.
function noteOf(raw: unknown): { ok: true; note: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false };
  const note = raw.trim();
  if (note === "") return { ok: true, note: null };
  if (note.length > REVIEW_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(note)) return { ok: false };
  return { ok: true, note };
}

export async function markReviewed(
  db: TenantDb,
  session: Session,
  invoiceId: string,
  rawNote: unknown,
  now: Date,
): Promise<ReviewWriteResult> {
  if (!isOn()) return refuse("disabled");
  if (!isCanonicalUuid(invoiceId)) return refuse("validation");
  const note = noteOf(rawNote);
  if (!note.ok) return refuse("validation");
  return db.withTenant(session.tenantId, async (q) => {
    const member = await membershipId(q, session);
    const [inv] = await q.query<{ status: string; reviewed_at: string | null }>(
      `SELECT status, CAST(reviewed_at AS text) AS reviewed_at FROM invoices
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [invoiceId],
    );
    if (!inv) return refuse("not_found");
    // Paid and void invoices are settled business, never reviewed.
    if (inv.status !== "open" && inv.status !== "partially_paid") return refuse("validation");
    const changed = await q.execute(
      `UPDATE invoices
          SET reviewed_at = CAST($2 AS timestamptz), reviewed_by_membership_id = CAST($3 AS uuid),
              review_note = $4
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND reviewed_at IS NULL`,
      [invoiceId, now.toISOString(), member, note.note],
    );
    return { ok: true, changed: changed === 1 };
  });
}

export async function markSent(
  db: TenantDb,
  session: Session,
  invoiceId: string,
  sentOn: unknown,
  now: Date,
): Promise<ReviewWriteResult> {
  if (!isOn()) return refuse("disabled");
  if (!isCanonicalUuid(invoiceId) || !isLocalDate(sentOn)) return refuse("validation");
  return db.withTenant(session.tenantId, async (q) => {
    const member = await membershipId(q, session);
    // The row is locked first, so the review read below and the write see the same invoice.
    const [locked] = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM invoices
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [invoiceId],
    );
    if (!locked) return refuse("not_found");
    const view = await readInvoiceReview(q, invoiceId);
    if (!view) return refuse("not_found");
    if (view.invoiceStatus !== "open" && view.invoiceStatus !== "partially_paid") return refuse("validation");
    if (view.sentOn !== null) return { ok: true, changed: false };
    if (view.madeByQueue && !view.posted) return refuse("not_posted");
    if (view.review.status !== "ready_to_send") return refuse("not_ready");
    // A send date is on or after the invoice's date and never after the carrier's today.
    const tenant = await readTenant(q);
    if (!tenant) return refuse("not_found");
    const today = localDateOf(now.toISOString(), tenant.timezone);
    if (sentOn < view.issuedOn || sentOn > today) return refuse("validation");
    // Under the lock, a queue-made invoice still needs its accounting id; history does not. The
    // choice is made here, between two statements, so no boolean parameter is ever sent.
    const changed = await q.execute(
      view.madeByQueue
        ? `UPDATE invoices SET sent_on = CAST($2 AS date), sent_by_membership_id = CAST($3 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
              AND sent_on IS NULL AND qbo_id IS NOT NULL`
        : `UPDATE invoices SET sent_on = CAST($2 AS date), sent_by_membership_id = CAST($3 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
              AND sent_on IS NULL`,
      [invoiceId, sentOn, member],
    );
    return { ok: true, changed: changed === 1 };
  });
}
