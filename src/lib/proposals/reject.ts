import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";

// A person rejects a proposal. It never touches the ledger. The note is a category from a fixed
// list only; the row holds no free text.

export const REJECT_CATEGORIES = [
  "wrong_amount",
  "wrong_record",
  "not_needed",
  "needs_review",
  "other",
] as const;
export type RejectCategory = (typeof REJECT_CATEGORIES)[number];

export type RejectResult = { ok: true } | { ok: false; category: "not_found" | "already_decided" };

export async function rejectProposal(
  session: Session,
  proposalId: string,
  category: RejectCategory,
  deps: { db?: TenantDb; clock?: () => Date } = {},
): Promise<RejectResult> {
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))().toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE proposals
          SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              decision_note = $4, updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
      [proposalId, session.sub, now, category],
    );
    if (n === 1) return { ok: true } as const;
    const rows = await q.query<{ id: string }>(
      "SELECT id FROM proposals WHERE id = CAST($1 AS uuid)",
      [proposalId],
    );
    return { ok: false, category: rows.length === 1 ? "already_decided" : "not_found" } as const;
  });
}
