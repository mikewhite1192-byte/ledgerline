import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { readNoteSource, recheckNote, type StoredNote } from "./pack";

// A person approves or rejects a drafted note. Approval never edits the text (the database guard
// refuses any change to it); it records who and when and delivers the note to the driver view in
// the same statement. Only a note that passed the check (drafted) can be decided: a refused,
// drafting or over_cap note is never approvable. Before approval the check runs again on the
// settlement as it is now (pack.ts recheckNote), so a note whose paystub changed after drafting is
// not approvable either. Nothing here sends anything; email is deliver.ts, behind its own switch.

export type DecideResult =
  | { ok: true }
  | { ok: false; category: "disabled" | "not_found" | "not_approvable" | "already_decided" };

// True for a drafted note that no longer matches its settlement. Any other status is left to the
// update below, which changes nothing and reports why.
async function draftNoLongerMatches(q: Queryable, noteId: string): Promise<boolean> {
  const rows = await q.query<StoredNote & { status: string; settlement_id: string }>(
    `SELECT status, CAST(settlement_id AS text) AS settlement_id, language, body,
            CAST(cited_seqs AS text) AS cited_seqs
       FROM driver_notes WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [noteId],
  );
  if (rows.length !== 1 || rows[0].status !== "drafted") return false;
  const source = await readNoteSource(q, rows[0].settlement_id);
  return source === null || !recheckNote(source, rows[0]);
}

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
    if (to === "approved" && (await draftNoLongerMatches(q, noteId))) {
      return { ok: false, category: "not_approvable" } as const;
    }
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
