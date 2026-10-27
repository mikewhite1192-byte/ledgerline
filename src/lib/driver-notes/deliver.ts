import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isLocalDate } from "../time/local-date";
import { readNoteSource, recheckNote } from "./pack";
import { periodWords } from "./words";

// Getting an approved note to the driver. The driver view is the delivery: approval marks the note
// delivered with channel driver_view, and the driver's view page shows it above the paystub
// (decide.ts). Email is the only outside write here, and it is off: it needs its own switch
// (driverNotesEmailEnabled), the driver's address on the allowlist (exact, lower-cased; an empty
// list refuses every address) and a configured sender. Until all three hold, delivery logs
// "would send note <id> (<category>)", never the address, and sends nothing. No sender ships in
// this change, so production never sends; tests hand in a fake one. The notes switch itself
// (driverNotesEnabled) is re-checked here too: with it off, nothing is emailed.
//
// An email cannot be recalled, so the note is checked once more against its settlement as it is
// now (pack.ts recheckNote) in the same transaction that reserves the send: a note whose paystub
// changed after approval is refused (stale) and nothing is sent.
//
// A release never notifies the backlog: email goes only for a period that ends on or after the
// start date (driverNotesEmailFrom), checked in the same transaction, before the reservation. The
// period's end is a date column on the carrier's calendar (periods are laid out in the carrier's
// named time zone) and the start is a whole date read the same way, so the database compares
// date to date, with no clock and no time zone shift. An older period is refused (before_start)
// and nothing is reserved or sent; its note stays on the driver view.
//
// An email is sent at most once: the note's channel moves from driver_view to email in its own
// transaction before the send (the reservation), so a retry, a second click or a crash after the
// send never sends again. Everything the message needs is worked out before the reservation, so
// nothing after it can fail but the send. A send that throws after the reservation may still have
// reached the provider: its outcome is unknown, it is never re-sent, and it is logged by category.

export type EmailMessage = { noteId: string; to: string; subject: string; text: string };
export type EmailSender = (message: EmailMessage) => Promise<void>;

export type EmailRefusal =
  | "disabled"
  | "not_allowlisted"
  | "no_sender"
  | "not_approved"
  | "already_sent"
  | "not_found"
  | "stale"
  | "before_start";
export type EmailResult = { sent: true } | { sent: false; category: EmailRefusal | "unknown" };

export type DeliverDeps = {
  db?: TenantDb;
  send?: EmailSender;
  log?: (line: string) => void;
  clock?: () => Date;
};

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
  cited_seqs: string | null;
  settlement_id: string;
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
              CAST(n.settlement_id AS text) AS settlement_id, CAST(n.cited_seqs AS text) AS cited_seqs,
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

  // Every check re-reads its switch here, whoever called. The log line names the note and the
  // category only.
  const refuse = (category: EmailRefusal): EmailResult => {
    log(`would send note ${noteId} (${category})`);
    return { sent: false, category };
  };
  if (!flags.driverNotesEnabled) return refuse("disabled");
  if (!flags.driverNotesEmailEnabled) return refuse("disabled");
  // A start that is not a whole date leaves no period known to be on or after it.
  const from = flags.driverNotesEmailFrom;
  if (!isLocalDate(from)) return refuse("disabled");
  if (!isAllowlisted(note.email, flags.driverNotesEmailAllowlist)) return refuse("not_allowlisted");
  if (!deps.send) return refuse("no_sender");

  // Before the reservation, so a date the words cannot read leaves the note unreserved.
  const language = note.language === "es" ? "es" : "en";
  const period = periodWords(language, note.period_start, note.period_end);

  const reserved = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const [end] = await q.query<{ on_or_after: unknown }>(
      `SELECT p.period_end >= CAST($2 AS date) AS on_or_after
         FROM driver_notes n
         JOIN settlement_periods p ON p.tenant_id = n.tenant_id AND p.id = n.period_id
        WHERE n.tenant_id = current_tenant_id() AND p.tenant_id = current_tenant_id()
          AND n.id = CAST($1 AS uuid)`,
      [noteId, from],
    );
    // Only a period read back as on or after the start goes on; anything else sends nothing.
    if (end?.on_or_after !== true) return "before_start" as const;
    // The text never changes once written (the table's guard), so the note read above is the
    // note; the settlement is read now. A missing settlement or a failed check sends nothing.
    const source = await readNoteSource(q, note.settlement_id);
    if (source === null || !recheckNote(source, note)) return "stale" as const;
    return q.execute(
      `UPDATE driver_notes SET channel = 'email', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND status = 'approved' AND channel = 'driver_view'`,
      [noteId, now],
    );
  });
  if (reserved === "stale" || reserved === "before_start") return { sent: false, category: reserved };
  if (reserved !== 1) return { sent: false, category: "already_sent" };

  try {
    await deps.send({
      noteId,
      to: note.email.trim().toLowerCase(),
      subject: language === "es" ? `Su pago ${period}` : `Your pay for ${period}`,
      text: note.body,
    });
    return { sent: true };
  } catch (err) {
    // The provider may have taken the message before the error: unknown, never "not sent".
    console.error("driver note email outcome unknown:", err instanceof Error ? err.name : "unknown");
    return { sent: false, category: "unknown" };
  }
}
