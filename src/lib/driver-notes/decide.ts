import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";

// A person approves or rejects a drafted note. Approval never edits the text (the database guard
// refuses any change to it); it records who and when and delivers the note to the driver view in
// the same statement. Only a note that passed the check (drafted) can be decided: a refused,
// drafting or over_cap note is never approvable. Nothing here sends anything; email is
// deliver.ts, behind its own switch.

export type DecideResult =
  | { ok: true }
  | { ok: false; category: "disabled" | "not_found" | "not_approvable" | "already_decided" };

async function decide(
  session: Session,
  noteId: string,
  to: "approved" | "rejected",
  deps: { db?: TenantDb; clock?: () => Date },
): Promise<DecideResult> {
  if (!flags.driverNotesEnabled) return { ok: false, category: "disabled" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n =
      to === "approved"
        ? await q.execute(
            `UPDATE driver_notes
                SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                    delivered_at = CAST($3 AS timestamptz), channel = 'driver_view',
                    updated_at = CAST($3 AS timestamptz)
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafted'`,
            [noteId, session.sub, now],
          )
        : await q.execute(
            `UPDATE driver_notes
                SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                    updated_at = CAST($3 AS timestamptz)
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafted'`,
            [noteId, session.sub, now],
          );
    if (n === 1) return { ok: true } as const;
    const rows = await q.query<{ status: string }>(
      "SELECT status FROM driver_notes WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [noteId],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found" } as const;
    const decided = rows[0].status === "approved" || rows[0].status === "rejected";
    return { ok: false, category: decided ? "already_decided" : "not_approvable" } as const;
  });
}

export function approveNote(session: Session, noteId: string, deps: { db?: TenantDb; clock?: () => Date } = {}) {
  return decide(session, noteId, "approved", deps);
}

export function rejectNote(session: Session, noteId: string, deps: { db?: TenantDb; clock?: () => Date } = {}) {
  return decide(session, noteId, "rejected", deps);
}
