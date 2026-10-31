import type { Session } from "../auth/claims";
import { isAutopilotSub } from "../autopilot/session";
import { getDb, type Queryable, type TenantDb } from "../db";
import { rejectAllowed } from "../money/never-alone";
import { ForbiddenError, assertMembership } from "../tenant/context";

// A person rejects a proposal. It never touches the ledger. The note is a category from a fixed
// list only; the row holds no free text. The proposal is locked first, then every ledger row tied
// to it (by its proposal id or the proposal's money_action_id) is read: once money may have left
// for it (a row reserved, sent, confirmed or unknown) the reject is refused as
// reject_after_money_moved and nothing is written (src/lib/money/never-alone.ts rejectAllowed). A
// ledger read that fails throws, so the transaction rolls back and nothing is rejected.
//
// A parked advance (src/lib/advances/approve.ts) is the one approved proposal a person may still
// reject: its advance is rejected with the category and who decided, and its proposal moves from
// approved (or executing) to failed with the note rejected_parked:<category>. It moves no money (a
// parked advance never has a ledger row; the rows are still read and the same rule applies), so it
// is allowed with the parking switch off too: it is the only way out of a park. Never the
// autopilot's.

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
    const rows = await q.query<{ status: string; kind: string; money_action_id: string | null }>(
      `SELECT status, kind, CAST(money_action_id AS text) AS money_action_id
         FROM proposals WHERE id = CAST($1 AS uuid) FOR UPDATE`,
      [proposalId],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found" } as const;
    if (
      rows[0].kind === "advance_payout" &&
      (rows[0].status === "approved" || rows[0].status === "executing") &&
      !isAutopilotSub(session.sub)
    ) {
      return rejectParked(q, session, proposalId, rows[0].money_action_id, category, now);
    }
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

// The parked branch, under the proposal lock the caller holds. Anything but a parked advance with
// no ledger row that money may have left for keeps the usual answers. The advance is read without
// a lock: a payout reserve locks the advance first and then writes the proposal, so locking the
// advance here, under the proposal lock, would take them in the opposite order. Nothing that moves
// an advance off parked runs without the proposal lock this transaction holds, and a reserve
// refuses a parked advance before it touches the proposal, so the UPDATE that requires parked is
// the guard: an advance that moved after the read is already decided.
async function rejectParked(
  q: Queryable,
  session: Session,
  proposalId: string,
  moneyActionId: string | null,
  category: RejectCategory,
  now: string,
): Promise<RejectResult> {
  const advance = await q.query<{ id: string; status: string }>(
    `SELECT CAST(id AS text) AS id, status FROM advances
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
    [proposalId],
  );
  if (advance.length !== 1 || advance[0].status !== "parked") return { ok: false, category: "already_decided" };
  const ledger = await q.query<{ state: string | null }>(
    `SELECT state FROM money_actions
      WHERE proposal_id = CAST($1 AS uuid) OR id = CAST($2 AS uuid)
         OR (subject_table = 'advances' AND subject_id = CAST($3 AS uuid))`,
    [proposalId, moneyActionId, advance[0].id],
  );
  if (ledger.some((r) => !rejectAllowed(typeof r.state === "string" ? r.state : "unreadable"))) {
    return { ok: false, category: "reject_after_money_moved" };
  }
  const by = await deciderOf(q, session);
  const a = await q.execute(
    `UPDATE advances
        SET status = 'rejected', reason_category = $2, decided_at = CAST($3 AS timestamptz),
            decided_by_membership_id = CAST($4 AS uuid)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'parked'`,
    [advance[0].id, category, now, by],
  );
  if (a !== 1) return { ok: false, category: "already_decided" };
  const p = await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'advance_payout'
        AND status IN ('approved', 'executing')`,
    [proposalId, `rejected_parked:${category}`, now],
  );
  // The proposal was read under its lock a moment ago: anything but one row is a state no path
  // writes, so the transaction rolls back rather than leave half a reject.
  if (p !== 1) throw new Error("reject: a parked advance did not move as read");
  return { ok: true };
}

// Who rejects a parked advance, as its decided_by_membership_id: the session's one membership in
// this tenant, staff or admin. No money moves, so this is a plain read, not an Approval.
async function deciderOf(q: Queryable, session: Session): Promise<string> {
  const rows = await q.query<{ id: unknown; role: unknown }>(
    `SELECT CAST(id AS text) AS id, role FROM memberships
      WHERE tenant_id = current_tenant_id() AND cognito_sub = $1`,
    [session.sub],
  );
  if (rows.length !== 1 || typeof rows[0].id !== "string" || (rows[0].role !== "admin" && rows[0].role !== "staff")) {
    throw new ForbiddenError();
  }
  return rows[0].id;
}
