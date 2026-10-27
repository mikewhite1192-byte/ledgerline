import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { periodWords } from "./words";

// Getting an approved note to the driver. The driver view is the delivery: approval marks the note
// delivered with channel driver_view, and the driver's view page shows it above the paystub
// (decide.ts). Email is the only outside write here, and it is off: it needs its own switch
// (driverNotesEmailEnabled), the driver's address on the allowlist (exact, lower-cased; an empty
// list refuses every address) and a configured sender. Until all three hold, delivery logs
// "would send note <id> to <masked address>" and sends nothing. No sender ships in this change, so
// production never sends; tests hand in a fake one.
//
// An email is sent at most once: the note's channel moves from driver_view to email in its own
// transaction before the send (the reservation), so a retry, a second click or a crash after the
// send never sends again. A send that fails after the reservation is left as it is (unknown, never
// re-sent) and logged by category.

export type EmailMessage = { noteId: string; to: string; subject: string; text: string };
export type EmailSender = (message: EmailMessage) => Promise<void>;

export type EmailRefusal = "disabled" | "not_allowlisted" | "no_sender" | "not_approved" | "already_sent" | "not_found";
export type EmailResult = { sent: true } | { sent: false; category: EmailRefusal | "send_failed" };

export type DeliverDeps = {
  db?: TenantDb;
  send?: EmailSender;
  log?: (line: string) => void;
  clock?: () => Date;
};

// "dr***@blueridge.example": the first two characters of the name part and the domain.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const name = email.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length - 1))}***${email.slice(at)}`;
}

// The allowlist check alone: exact whole-address match, lower-cased and trimmed on both sides.
export function isAllowlisted(email: string, allowlist: readonly string[]): boolean {
  const address = email.trim().toLowerCase();
  if (!address) return false;
  return allowlist.some((entry) => entry.trim().toLowerCase() === address);
}

type NoteForEmail = {
  status: string;
  channel: string | null;
  body: string | null;
  email: string;
  period_start: string;
  period_end: string;
  language: string;
};

export async function deliverNoteEmail(
  session: Session,
  noteId: string,
  deps: DeliverDeps = {},
): Promise<EmailResult> {
  const db = deps.db ?? getDb();
  const log = deps.log ?? ((line: string) => console.info(line));
  const now = (deps.clock ?? (() => new Date()))().toISOString();

  const note = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const rows = await q.query<NoteForEmail>(
      `SELECT n.status, n.channel, n.body, n.language, d.email,
              to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(p.period_end, 'YYYY-MM-DD') AS period_end
         FROM driver_notes n
         JOIN drivers d ON d.tenant_id = n.tenant_id AND d.id = n.driver_id
         JOIN settlement_periods p ON p.tenant_id = n.tenant_id AND p.id = n.period_id
        WHERE n.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
          AND p.tenant_id = current_tenant_id() AND n.id = CAST($1 AS uuid)`,
      [noteId],
    );
    return rows[0] ?? null;
  });
  if (!note) return { sent: false, category: "not_found" };
  if (note.status !== "approved" || note.body === null) return { sent: false, category: "not_approved" };
  if (note.channel === "email") return { sent: false, category: "already_sent" };

  // Every check re-reads its switch here, whoever called.
  const masked = maskEmail(note.email);
  const refuse = (category: EmailRefusal): EmailResult => {
    log(`would send note ${noteId} to ${masked} (${category})`);
    return { sent: false, category };
  };
  if (!flags.driverNotesEmailEnabled) return refuse("disabled");
  if (!isAllowlisted(note.email, flags.driverNotesEmailAllowlist)) return refuse("not_allowlisted");
  if (!deps.send) return refuse("no_sender");

  const reserved = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return q.execute(
      `UPDATE driver_notes SET channel = 'email', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND status = 'approved' AND channel = 'driver_view'`,
      [noteId, now],
    );
  });
  if (reserved !== 1) return { sent: false, category: "already_sent" };

  const language = note.language === "es" ? "es" : "en";
  const period = periodWords(language, note.period_start, note.period_end);
  try {
    await deps.send({
      noteId,
      to: note.email.trim().toLowerCase(),
      subject: language === "es" ? `Su pago ${period}` : `Your pay for ${period}`,
      text: note.body,
    });
    return { sent: true };
  } catch (err) {
    console.error("driver note email failed:", err instanceof Error ? err.name : "unknown");
    return { sent: false, category: "send_failed" };
  }
}
