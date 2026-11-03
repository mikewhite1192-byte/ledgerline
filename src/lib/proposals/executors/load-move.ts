import { flags } from "../../../config/flags";
import { requireStaff } from "../../auth/role";
import type { Queryable } from "../../db";
import { cancelledTripEnabled } from "../../deficits/switches";
import { staffMoveIn, type StaffMoveTo } from "../../loads/movement";
import { isLocalDate } from "../../time/local-date";
import { isUuid } from "../../uuid";
import type { Executor, Precheck, ProposalRefused, ProposalResult, ProposalRow } from "../execute";

// A load_move card a person approved (src/lib/loads/movement.ts made it when code could not decide
// a move): the one move the card names, made as the person's own press (source staff), under the
// same status guard and CHECKs as any move. No money moves and nothing is sent. Read through
// loadMovement.enabled on every approval. A card that names no load or no move (a message with no
// whole load number, say) is refused as not_executable: the person moves that load on its own page.
// A card that names the cancel (the dispatch system withdrew the load) is executable only while
// flags.cancelledTrip is on, asked here on every approval and again by staffMoveIn on its date.

const done = (proposalId: string): ProposalResult => ({ ok: true, proposalId, status: "done", moneyActionId: null });
const refusal = (category: string, retryable = false): ProposalRefused => ({ ok: false, category, retryable });

type MoveArgs = { loadId: string; toStatus: StaffMoveTo; deliveredOn: string | null };

function argsOf(raw: unknown, proposal: Pick<ProposalRow, "subjectTable" | "subjectId" | "amountCents">): MoveArgs | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.loadId !== "string" || !isUuid(a.loadId)) return null;
  const cancel = a.toStatus === "cancelled" && cancelledTripEnabled();
  if (a.toStatus !== "in_transit" && a.toStatus !== "delivered" && !cancel) return null;
  const deliveredOn = a.deliveredOn ?? null;
  if (deliveredOn !== null && !isLocalDate(deliveredOn)) return null;
  if (proposal.amountCents !== 0) return null;
  if (proposal.subjectTable !== "loads" || proposal.subjectId !== a.loadId) return null;
  const toStatus: StaffMoveTo = cancel ? "cancelled" : a.toStatus === "delivered" ? "delivered" : "in_transit";
  return { loadId: a.loadId, toStatus, deliveredOn: toStatus === "delivered" ? deliveredOn : null };
}

const precheck: Precheck = async (q, proposal, _now, ctx) => {
  if (!flags.loadMovement.enabled || proposal.kind !== "load_move" || !ctx) return refusal("not_executable");
  await requireStaff(q, ctx.session);
  return argsOf(proposal.args, proposal) ? null : refusal("not_executable");
};

async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`load move ${proposalId} refused: ${category}`);
  return refusal(category);
}

async function one(q: Queryable, sql: string, params: (string | number | null)[]): Promise<void> {
  if ((await q.execute(sql, params)) !== 1) throw new Error("a load move write did not change exactly one row");
}

const execute: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.loadMovement.enabled || proposal.kind !== "load_move") return refusal("not_executable");
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    await requireStaff(q, session);
    const locked = await q.query<{ status: string; args: string }>(
      `SELECT status, CAST(args AS text) AS args FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'load_move'
        FOR UPDATE`,
      [proposal.id],
    );
    if (locked.length !== 1) return refusal("not_found");
    const row = locked[0];
    if (row.status === "done") return done(proposal.id);
    if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");
    let raw: unknown;
    try {
      raw = JSON.parse(row.args);
    } catch {
      raw = null;
    }
    const args = argsOf(raw, proposal);
    if (!args) return fail(q, proposal.id, "not_executable", nowIso);

    const moved = await staffMoveIn(q, args.loadId, args.toStatus, now, args.deliveredOn);
    if (!moved.ok) return fail(q, proposal.id, moved.category, nowIso);

    if (row.status === "approved") {
      await one(
        q,
        `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
        [proposal.id, nowIso],
      );
    }
    await one(
      q,
      `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [proposal.id, nowIso],
    );
    console.info(`load move ${proposal.id} done changed=${moved.changed}`);
    return done(proposal.id);
  });
};

export const loadMoveExecutor: Executor = Object.assign(execute, { precheck });
