import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { parseFigures } from "./pack";
import { readInvoiceBalance, sendReminder, stagePassed, type SendDeps, type SendResult } from "./send";

// A person approves or rejects a drafted reminder. Any member may: a reminder moves no money.
// Approval never edits the text (the table's guard refuses any change to it); it records who and
// when and records the reminder (channel 'logged') in the same statement. Only a reminder that
// passed the check (drafted) can be decided.
//
// Before approval the invoice is read again in the same transaction, from the money applied to it
// now: a reminder for an invoice that was voided, paid, or paid down below the reminder's balance
// since drafting is refused (paid_since), and one whose balance went up is refused (changed). A
// reminder whose invoice has since reached its next stage (drafted at 30, the invoice now 60 days
// late on the carrier's calendar) is refused too (stage_passed): that stage gets its own reminder.
// The reminder stays drafted, so a person can reject it. After approval, outside that transaction,
// the email path runs (send.ts, behind its own switches); its outcome never undoes the approval,
// and an email step that throws leaves the email outcome unknown, never "not sent".

export type DecideRefusal = "disabled" | "not_found" | "not_approvable" | "already_decided" | "paid_since" | "changed";
export type ApproveRefusal = DecideRefusal | "stage_passed";

// channel: logged when no email was reserved, email once one was (sent or not confirmed), unknown
// when the email step failed before saying which.
export type ApproveResult =
  | { ok: true; status: "approved"; channel: "logged" | "email" | "unknown"; email: SendResult }
  | { ok: false; category: ApproveRefusal };

export type RejectResult = { ok: true; status: "rejected" } | { ok: false; category: DecideRefusal };

export type DecideDeps = SendDeps;

type Row = { status: string; stage: string; invoice_id: string; figures: string };

export async function approveReminder(session: Session, id: string, deps: DecideDeps = {}): Promise<ApproveResult> {
  if (!flags.collectionsEnabled) return { ok: false, category: "disabled" };
  const db = deps.db ?? getDb();
  const at = (deps.clock ?? (() => new Date()))();
  const now = at.toISOString();
  const decided = await db.withTenant(session.tenantId, async (q): Promise<{ ok: true } | { ok: false; category: ApproveRefusal }> => {
    await assertMembership(q, session);
    const rows = await q.query<Row>(
      `SELECT status, stage, CAST(invoice_id AS text) AS invoice_id, CAST(figures AS text) AS figures
         FROM collection_drafts WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        FOR UPDATE`,
      [id],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found" };
    const row = rows[0];
    if (row.status === "approved" || row.status === "rejected") return { ok: false, category: "already_decided" };
    if (row.status !== "drafted") return { ok: false, category: "not_approvable" };
    const figures = parseFigures(row.figures);
    if (!figures) return { ok: false, category: "not_approvable" };
    const balance = await readInvoiceBalance(q, row.invoice_id);
    if (balance === null) return { ok: false, category: "not_found" };
    if (balance.status === "void" || balance.balanceCents < figures.balanceCents) {
      return { ok: false, category: "paid_since" };
    }
    if (balance.balanceCents !== figures.balanceCents) return { ok: false, category: "changed" };
    if (await stagePassed(q, figures, row.stage, at)) return { ok: false, category: "stage_passed" };
    const n = await q.execute(
      `UPDATE collection_drafts
          SET status = 'approved', channel = 'logged', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              updated_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafted'`,
      [id, session.sub, now],
    );
    return n === 1 ? { ok: true } : { ok: false, category: "already_decided" };
  });
  if (!decided.ok) return decided;
  let email: SendResult;
  try {
    email = await sendReminder(session, id, deps);
  } catch (err) {
    // The approval is saved; the email step stopped somewhere unknown. Only the error's name is logged.
    console.error("collections reminder email step failed after approval:", err instanceof Error ? err.name : "unknown");
    return { ok: true, status: "approved", channel: "unknown", email: { sent: false, category: "unknown" } };
  }
  // sendReminder answers unknown only after its reservation moved the channel to email.
  const channel = email.sent || email.category === "unknown" ? "email" : "logged";
  return { ok: true, status: "approved", channel, email };
}

export async function rejectReminder(session: Session, id: string, deps: { db?: TenantDb; clock?: () => Date } = {}): Promise<RejectResult> {
  if (!flags.collectionsEnabled) return { ok: false, category: "disabled" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  return db.withTenant(session.tenantId, async (q): Promise<RejectResult> => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE collection_drafts
          SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              updated_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafted'`,
      [id, session.sub, now],
    );
    if (n === 1) return { ok: true, status: "rejected" };
    const rows = await q.query<{ status: string }>(
      "SELECT status FROM collection_drafts WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [id],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found" };
    const done = rows[0].status === "approved" || rows[0].status === "rejected";
    return { ok: false, category: done ? "already_decided" : "not_approvable" };
  });
}
