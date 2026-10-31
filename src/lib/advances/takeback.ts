import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject } from "../money/read";
import type { MoneyAction } from "../money/types";
import { flags } from "../../config/flags";
import { proposePull, type PullProposeResult } from "../pullbacks/propose";
import { pullbackOn } from "../pullbacks/switches";
import { isPullbackReason } from "../pullbacks/words";
import { failAdvanceProposal } from "./approve";
import { readMember } from "./member";
import { readAdvanceView, type AdvanceView } from "./rows";
import { advancesOn } from "./switches";
import { CANCELLED_BY_TAKEBACK, isTakebackReason } from "./takeback-words";

// Taking an advance back (decision D-034: record only). An advance not yet paid, with no payout
// that may have moved money, is cancelled: nothing was paid, so nothing is taken. A paid advance
// records the amount taken back, which stops counting as owed (outstandingCents) and is not
// recovered from settlements; nothing is pulled off the card and no outside system is called.
// A cancelled advance born from an approval ends its proposal too, as failed with a note, so the
// approval is never left running on an advance that is gone (resume and retry then refuse it).
// One per advance: the same amount again returns the row unchanged, a different amount is
// refused. One tenant transaction with the advance locked. Staff may take back up to the
// approver rule's line; above it, only an admin.
//
// With the card pull-back switch on (S6), a paid advance's take-back makes a pull-back card for a
// person to approve instead of recording the amount (src/lib/pullbacks/propose.ts); the approved
// pull then records it. A cancel is unchanged: nothing was paid, so nothing is pulled.

export { TAKEBACK_REASONS, isTakebackReason, type TakebackReason } from "./takeback-words";

export type TakebackRefusal = "bad_request" | "already_taken_back" | "over_bound" | "not_takeable";

export type TakebackPlan =
  | { kind: "cancel" }
  | { kind: "record"; cents: number }
  | { kind: "same" }
  | { kind: "refuse"; category: TakebackRefusal };

type PlanAdvance = Pick<
  AdvanceView,
  "status" | "amountCents" | "feeCents" | "recoveredCents" | "takenBackCents" | "takenBackAt"
>;

// A payout row that may have moved money, or is about to: the outcome is not a definite no.
const IN_FLIGHT: readonly MoneyAction["state"][] = ["reserved", "sent", "unknown", "confirmed"];

// Pure: what a take-back of amountCents does to this advance, given its payout rows. maxCents is
// the switch's cap on one take-back.
export function takebackPlan(
  advance: PlanAdvance,
  payouts: readonly Pick<MoneyAction, "state">[],
  amountCents: number,
  maxCents: number,
): TakebackPlan {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) return { kind: "refuse", category: "bad_request" };
  if (advance.takenBackAt !== null) {
    // Once only: the same amount again is the same take-back.
    return advance.takenBackCents === amountCents ||
      (advance.status === "cancelled" && advance.takenBackCents === 0)
      ? { kind: "same" }
      : { kind: "refuse", category: "already_taken_back" };
  }
  if (advance.status === "requested" || advance.status === "approved") {
    if (payouts.some((p) => IN_FLIGHT.includes(p.state))) return { kind: "refuse", category: "not_takeable" };
    return { kind: "cancel" };
  }
  if (advance.status !== "paid") return { kind: "refuse", category: "not_takeable" };
  if (amountCents === 0) return { kind: "refuse", category: "bad_request" };
  const stillOwed = advance.amountCents + advance.feeCents - advance.recoveredCents;
  if (amountCents > stillOwed || amountCents > maxCents) return { kind: "refuse", category: "over_bound" };
  return { kind: "record", cents: amountCents };
}

export type TakebackResult =
  | { ok: true; changed: boolean; status: string; takenBackCents: number }
  | { ok: true; changed: boolean; proposalId: string }
  | {
      ok: false;
      category: TakebackRefusal | "disabled" | "not_found" | "role" | Extract<PullProposeResult, { ok: false }>["category"];
      retryable: false;
    };

const no = (category: Exclude<TakebackResult, { ok: true }>["category"]): TakebackResult => ({
  ok: false,
  category,
  retryable: false,
});

export async function takeBackAdvance(
  session: Session,
  advanceId: string,
  input: { amountCents: number; reason: string },
  deps: { db?: TenantDb; clock?: () => Date } = {},
): Promise<TakebackResult> {
  // The switches first, asked here as well as by the route.
  if (!advancesOn() || flags.advanceTakeback.enabled !== true) return no("disabled");
  if (!isCanonicalUuid(advanceId) || !isTakebackReason(input.reason)) return no("bad_request");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) return no("bad_request");
  const db = deps.db ?? getDb();
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    const member = await readMember(q, session);
    const advance = await readAdvanceView(q, advanceId, true);
    if (!advance) return no("not_found");
    const payouts = (await readBySubject(q, "advances", advance.id)).filter((a) => a.kind === "advance_payout");
    const plan = takebackPlan(advance, payouts, input.amountCents, flags.advanceTakeback.maxCents);
    if (plan.kind === "refuse") return no(plan.category);
    if (plan.kind === "same") {
      return { ok: true, changed: false, status: advance.status, takenBackCents: advance.takenBackCents };
    }
    // The approver rule's line: what is taken back, or for a cancel the advance itself.
    const size = plan.kind === "record" ? plan.cents : advance.amountCents;
    if (size > flags.approverRole.adminAboveCents && member.role !== "admin") return no("role");
    if (plan.kind === "record" && pullbackOn()) {
      // Every take-back reason is a pull-back reason; asked again so the type narrows here.
      if (!isPullbackReason(input.reason)) return no("bad_request");
      const card = await proposePull(
        q,
        session,
        { driverId: advance.driverId, advanceId: advance.id, reason: input.reason, requestedCents: plan.cents },
        new Date(nowIso),
      );
      return card.ok ? { ok: true, changed: card.changed, proposalId: card.proposalId } : no(card.category);
    }
    const changed =
      plan.kind === "cancel"
        ? await q.execute(
            `UPDATE advances
                SET status = 'cancelled', taken_back_cents = 0, taken_back_at = CAST($2 AS timestamptz),
                    taken_back_by_membership_id = CAST($3 AS uuid), takeback_reason = $4
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
                AND status IN ('requested', 'approved') AND taken_back_at IS NULL`,
            [advance.id, nowIso, member.id, input.reason],
          )
        : await q.execute(
            `UPDATE advances
                SET taken_back_cents = $5, taken_back_at = CAST($2 AS timestamptz),
                    taken_back_by_membership_id = CAST($3 AS uuid), takeback_reason = $4
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
                AND status = 'paid' AND taken_back_at IS NULL`,
            [advance.id, nowIso, member.id, input.reason, plan.cents],
          );
    // The row is locked, so a miss means it is not what was just read: never a silent success.
    if (changed !== 1) return no("not_takeable");
    // Cancelled before any payout row was reserved: the proposal it came from (approved, or
    // executing with no ledger row) has nothing left to run. The advance lock comes first here, as
    // in the ledger's reserve, so the two never wait on each other in turn.
    if (plan.kind === "cancel" && advance.proposalId !== null) {
      await failAdvanceProposal(q, advance.proposalId, CANCELLED_BY_TAKEBACK, nowIso);
    }
    return plan.kind === "cancel"
      ? { ok: true, changed: true, status: "cancelled", takenBackCents: 0 }
      : { ok: true, changed: true, status: "paid", takenBackCents: plan.cents };
  });
}
