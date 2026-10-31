import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { rejectAllowed } from "../money/never-alone";
import { assertMembership } from "../tenant/context";

// A person rejects a proposal. It never touches the ledger. The note is a category from a fixed
// list only; the row holds no free text. The proposal is locked first, then every ledger row tied
// to it (by its proposal id or the proposal's money_action_id) is read: once money may have left
// for it (a row reserved, sent, confirmed or unknown) the reject is refused as
// reject_after_money_moved and nothing is written (src/lib/money/never-alone.ts rejectAllowed). A
// ledger read that fails throws, so the transaction rolls back and nothing is rejected.

export const REJECT_CATEGORIES = [
  "wrong_amount",
  "wrong_record",
  "not_needed",
  "needs_review",
  "other",
] as const;
export type RejectCategory = (typeof REJECT_CATEGORIES)[number];

export type RejectResult =
  | { ok: true }
  | { ok: false; category: "not_found" | "already_decided" | "reject_after_money_moved" };

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
    const rows = await q.query<{ status: string; money_action_id: string | null }>(
      `SELECT status, CAST(money_action_id AS text) AS money_action_id
         FROM proposals WHERE id = CAST($1 AS uuid) FOR UPDATE`,
      [proposalId],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found" } as const;
    if (rows[0].status !== "proposed") return { ok: false, category: "already_decided" } as const;
    const ledger = await q.query<{ state: string | null }>(
      `SELECT state FROM money_actions
        WHERE proposal_id = CAST($1 AS uuid) OR id = CAST($2 AS uuid)`,
      [proposalId, rows[0].money_action_id],
    );
    if (ledger.some((r) => !rejectAllowed(typeof r.state === "string" ? r.state : "unreadable"))) {
      return { ok: false, category: "reject_after_money_moved" } as const;
    }
    const n = await q.execute(
      `UPDATE proposals
          SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              decision_note = $4, updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
      [proposalId, session.sub, now, category],
    );
    if (n === 1) return { ok: true } as const;
    return { ok: false, category: "already_decided" } as const;
  });
}
