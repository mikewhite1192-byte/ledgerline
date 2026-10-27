import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { isAllowlisted, type EmailSender } from "../driver-notes/deliver";
import { invoiceStatus } from "../rules-engine/receivables";
import { assertMembership } from "../tenant/context";
import { isLocalDate } from "../time/local-date";
import { parseFigures } from "./pack";

// Emailing an approved reminder to the customer. Approval records the reminder (channel 'logged');
// an email is the only outside write here, and it is off. It needs every one of these, each
// re-read here whoever calls:
//   - collectionsEnabled and collectionsEmailEnabled on;
//   - collectionsEmailFrom a whole date, and the reminder drafted on or after it (the carrier's
//     calendar), so switching email on never sends the backlog;
//   - the customer's billing address on collectionsEmailAllowlist (exact, lower-cased; an empty
//     list refuses every address);
//   - a sender handed in. None ships in this change, so production never sends; tests hand in a
//     fake one.
// Until all hold it logs "collections: would send reminder <id> (<category>)", never the address,
// and sends nothing. Seeded billing addresses end in .example (reserved, undeliverable) too.
//
// An email cannot be recalled, so in the transaction that reserves the send the invoice is read
// again: if its balance is no longer the reminder's balance (paid or changed since), nothing is
// sent (stale). An email goes at most once: the channel moves from logged to email in that same
// transaction before the send (the reservation), so a retry, a second click or a crash after the
// send never sends again. sent_at is written after the send went out. A send that throws may still
// have reached the provider: its outcome is unknown, it is never re-sent, and only the error's
// name is logged.

export type SendRefusal =
  | "disabled"
  | "before_start"
  | "no_address"
  | "not_allowlisted"
  | "no_sender"
  | "not_approved"
  | "already_sent"
  | "not_found"
  | "stale";
export type SendResult = { sent: true } | { sent: false; category: SendRefusal | "unknown" };

export type SendDeps = {
  db?: TenantDb;
  send?: EmailSender;
  log?: (line: string) => void;
  clock?: () => Date;
};

export type InvoiceBalance = { status: "void" | "open" | "partially_paid" | "paid"; balanceCents: number };

// The invoice's balance from the money applied to it now, not its stored status. Null when the
// invoice is not this carrier's.
export async function readInvoiceBalance(q: Queryable, invoiceId: string): Promise<InvoiceBalance | null> {
  const rows = await q.query<{ amount_cents: number | string; status: string; applied: number | string }>(
    `SELECT i.amount_cents, i.status,
            CAST(COALESCE((SELECT sum(a.amount_cents) FROM payment_applications a
                            WHERE a.tenant_id = current_tenant_id() AND a.invoice_id = i.id), 0) AS bigint) AS applied
       FROM invoices i
      WHERE i.tenant_id = current_tenant_id() AND i.id = CAST($1 AS uuid)`,
    [invoiceId],
  );
  if (rows.length !== 1) return null;
  if (rows[0].status === "void") return { status: "void", balanceCents: 0 };
  const amount = Number(rows[0].amount_cents);
  const applied = Number(rows[0].applied);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(applied)) throw new Error("an invoice amount is unreadable");
  const s = invoiceStatus(amount, applied);
  return { status: s.status, balanceCents: s.balanceCents };
}

type ReminderForEmail = {
  status: string;
  channel: string | null;
  subject: string | null;
  body: string | null;
  invoice_id: string;
  figures: string;
  billing_email: string | null;
};

export async function sendReminder(session: Session, id: string, deps: SendDeps = {}): Promise<SendResult> {
  const db = deps.db ?? getDb();
  const log = deps.log ?? ((line: string) => console.info(line));
  const clock = deps.clock ?? (() => new Date());

  const draft = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const rows = await q.query<ReminderForEmail>(
      `SELECT d.status, d.channel, d.subject, d.body, CAST(d.invoice_id AS text) AS invoice_id,
              CAST(d.figures AS text) AS figures, c.billing_email
         FROM collection_drafts d
         JOIN customers c ON c.tenant_id = d.tenant_id AND c.id = d.customer_id
        WHERE d.tenant_id = current_tenant_id() AND c.tenant_id = current_tenant_id()
          AND d.id = CAST($1 AS uuid)`,
      [id],
    );
    return rows[0] ?? null;
  });
  if (!draft) return { sent: false, category: "not_found" };
  if (draft.status !== "approved" || draft.subject === null || draft.body === null) {
    return { sent: false, category: "not_approved" };
  }
  if (draft.channel !== "logged") return { sent: false, category: "already_sent" };

  // The log line names the reminder and the category only, never the address.
  const refuse = (category: SendRefusal): SendResult => {
    log(`collections: would send reminder ${id} (${category})`);
    return { sent: false, category };
  };
  if (!flags.collectionsEnabled || !flags.collectionsEmailEnabled) return refuse("disabled");
  // A start that is not a whole date leaves no reminder known to be on or after it.
  const from = flags.collectionsEmailFrom;
  if (!isLocalDate(from)) return refuse("disabled");
  const to = (draft.billing_email ?? "").trim().toLowerCase();
  if (!to) return refuse("no_address");
  if (!isAllowlisted(to, flags.collectionsEmailAllowlist)) return refuse("not_allowlisted");
  if (!deps.send) return refuse("no_sender");
  const figures = parseFigures(draft.figures);
  if (!figures) return refuse("stale");

  const reserved = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const [when] = await q.query<{ on_or_after: unknown }>(
      `SELECT CAST(timezone(t.timezone, d.created_at) AS date) >= CAST($2 AS date) AS on_or_after
         FROM collection_drafts d
         JOIN tenants t ON t.id = d.tenant_id
        WHERE d.tenant_id = current_tenant_id() AND t.id = current_tenant_id() AND d.id = CAST($1 AS uuid)`,
      [id, from],
    );
    // Only a reminder read back as drafted on or after the start goes on; anything else sends nothing.
    if (when?.on_or_after !== true) return "before_start" as const;
    const balance = await readInvoiceBalance(q, draft.invoice_id);
    if (balance === null || balance.status === "void" || balance.balanceCents !== figures.balanceCents) {
      return "stale" as const;
    }
    return q.execute(
      `UPDATE collection_drafts SET channel = 'email', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND status = 'approved' AND channel = 'logged'`,
      [id, clock().toISOString()],
    );
  });
  if (reserved === "before_start" || reserved === "stale") return refuse(reserved);
  if (reserved !== 1) return { sent: false, category: "already_sent" };

  try {
    await deps.send({ noteId: id, to, subject: draft.subject, text: draft.body });
  } catch (err) {
    // The provider may have taken the message before the error: unknown, never "not sent".
    console.error("collections reminder email outcome unknown:", err instanceof Error ? err.name : "unknown");
    return { sent: false, category: "unknown" };
  }
  try {
    await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      await q.execute(
        `UPDATE collection_drafts SET sent_at = CAST($2 AS timestamptz), updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
            AND status = 'approved' AND channel = 'email' AND sent_at IS NULL`,
        [id, clock().toISOString()],
      );
    });
  } catch (err) {
    // The email went out; only its time was not written. The page says it is not confirmed as sent.
    console.error("collections reminder send time not recorded:", err instanceof Error ? err.name : "unknown");
  }
  return { sent: true };
}
