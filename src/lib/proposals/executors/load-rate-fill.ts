import type { Queryable } from "../../db";
import { assertMembership } from "../../tenant/context";
import type { Executor, ProposalResult } from "../execute";

// Approval of a load_rate_fill proposal: write the rate confirmation's linehaul and fuel
// surcharge onto the load, once, only while the load still has no rate. No money moves, no ledger
// row, no outside call. One tenant transaction holds the proposal lock, the load write and the
// status change, so a crash leaves either all of it or none of it.
//
// On a resume (the proposal approved or executing), the load write finds no empty rate: if the
// load now carries exactly these values the fill already happened and the proposal is done; any
// other values mean the load changed since, and the proposal fails with 'changed_since'. Args that
// are not whole cents in range fail closed with 'invalid_args'.

const MAX_CENTS = 999_999_999;

const isCents = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= MAX_CENTS;

async function moveTo(q: Queryable, id: string, from: string, to: string, nowIso: string, note: string | null) {
  return q.execute(
    `UPDATE proposals
        SET status = $3, decision_note = COALESCE($4, decision_note), money_action_id = NULL,
            updated_at = CAST($5 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = $2`,
    [id, from, to, note, nowIso],
  );
}

// approved -> failed directly, or executing -> failed.
async function fail(q: Queryable, id: string, status: string, nowIso: string, note: string): Promise<ProposalResult> {
  await moveTo(q, id, status, "failed", nowIso, note);
  return { ok: false, category: note, retryable: false };
}

// approved -> executing -> done (the guard allows only those steps), or executing -> done.
async function finish(q: Queryable, id: string, status: string, nowIso: string): Promise<ProposalResult> {
  if (status === "approved") await moveTo(q, id, "approved", "executing", nowIso, null);
  const moved = await moveTo(q, id, "executing", "done", nowIso, null);
  if (moved !== 1) throw new Error("the proposal did not move to done");
  return { ok: true, proposalId: id, status: "done", moneyActionId: null };
}

export const loadRateFill: Executor = async (db, session, proposal, _opts, deps) => {
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  const { loadId, linehaulCents, fuelSurchargeCents } = proposal.args;
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const locked = await q.query<{ status: string }>(
      `SELECT status FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [proposal.id],
    );
    const status = locked[0]?.status;
    if (status !== "approved" && status !== "executing") {
      return { ok: false, category: "already_decided", retryable: false };
    }
    if (
      proposal.kind !== "load_rate_fill" ||
      proposal.subjectTable !== "loads" ||
      loadId !== proposal.subjectId ||
      !isCents(linehaulCents, 1) ||
      !isCents(fuelSurchargeCents, 0)
    ) {
      return fail(q, proposal.id, status, nowIso, "invalid_args");
    }
    const written = await q.execute(
      `UPDATE loads SET linehaul_cents = $2, fuel_surcharge_cents = $3
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND linehaul_cents IS NULL`,
      [proposal.subjectId, linehaulCents, fuelSurchargeCents],
    );
    if (written === 1) return finish(q, proposal.id, status, nowIso);
    const now = await q.query<{ linehaul_cents: number | string | null; fuel_surcharge_cents: number | string }>(
      `SELECT linehaul_cents, fuel_surcharge_cents FROM loads
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [proposal.subjectId],
    );
    const load = now[0];
    if (!load) return fail(q, proposal.id, status, nowIso, "changed_since");
    const same =
      load.linehaul_cents !== null &&
      Number(load.linehaul_cents) === linehaulCents &&
      Number(load.fuel_surcharge_cents) === fuelSurchargeCents;
    return same ? finish(q, proposal.id, status, nowIso) : fail(q, proposal.id, status, nowIso, "changed_since");
  });
};
