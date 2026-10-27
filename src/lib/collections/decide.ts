import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { parseFigures } from "./pack";
import { readInvoiceBalance, sendReminder, type SendDeps, type SendResult } from "./send";

// A person approves or rejects a drafted reminder. Any member may: a reminder moves no money.
// Approval never edits the text (the table's guard refuses any change to it); it records who and
// when and records the reminder (channel 'logged') in the same statement. Only a reminder that
// passed the check (drafted) can be decided.
//
// Before approval the invoice is read again in the same transaction, from the money applied to it
// now: a reminder for an invoice that was voided, paid, or paid down below the reminder's balance
// since drafting is refused (paid_since), and one whose balance went up is refused (changed). The
// reminder stays drafted, so a person can reject it. After approval, outside that transaction, the
// email path runs (send.ts, behind its own switches); its outcome never undoes the approval.

export type DecideRefusal = "disabled" | "not_found" | "not_approvable" | "already_decided" | "paid_since" | "changed";

export type ApproveResult =
  | { ok: true; status: "approved"; channel: "logged" | "email"; email: SendResult }
  | { ok: false; category: DecideRefusal };

export type RejectResult = { ok: true; status: "rejected" } | { ok: false; category: DecideRefusal };

export type DecideDeps = SendDeps;

type Row = { status: string; invoice_id: string; figures: string };

export async function approveReminder(session: Session, id: string, deps: DecideDeps = {}): Promise<ApproveResult> {
  if (!flags.collectionsEnabled) return { ok: false, category: "disabled" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  const decided = await db.withTenant(session.tenantId, async (q): Promise<{ ok: true } | { ok: false; category: DecideRefusal }> => {
    await assertMembership(q, session);
    const rows = await q.query<Row>(
      `SELECT status, CAST(invoice_id AS text) AS invoice_id, CAST(figures AS text) AS figures
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
  const email = await sendReminder(session, id, deps);
  return { ok: true, status: "approved", channel: email.sent ? "email" : "logged", email };
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
