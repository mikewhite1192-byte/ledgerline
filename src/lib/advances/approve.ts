import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readAdvanceInput } from "../data/read";
import { DEFAULT_TIMEOUT_MS, executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MAX_ATTEMPT, MoneyError, type MoneyAction, type MoneyFailure } from "../money/types";
import type {
  ApproveOptions,
  ExecuteDeps,
  PrecheckContext,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../proposals/execute";
import { isAutopilotSub } from "../autopilot/session";
import { advanceEligibility, type AdvanceDecision } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { readCardDestination, readPayoutCard, type CardOnFile } from "./cards";
import { cardNameMatches, readCardStatementName } from "./identity";
import { parkingOn, parkReasonOf, type ParkReason } from "./parking";
import { expenseReconcileHooks, postAdvanceExpense } from "./post-expense";
import { requestRefOf, sourceOfInput } from "./request";
import { readFlowAdvance, readFlowAdvanceByProposal, type FlowAdvance } from "./rows";
import { advancesOn, payoutGate, type PayoutRefusal } from "./switches";

// A person approves an advance proposal, and only then does the advance exist (design D2). The
// proposal gate (src/lib/proposals/execute.ts) has already checked the role, the auditor and the
// second confirm, and asked precheckAdvanceProposal before approving, so a payout that could not
// run is refused while the proposal still waits; this executor then, in one tenant transaction
// with the proposal and the driver locked: asks the payout switches again, re-runs the rules
// engine as of now (a proposal whose numbers no longer hold is rejected, never paid), moves the
// proposal on to executing, and writes the advances row as requested. The money executor then
// reserves the payout's ledger row (the advance becomes approved in that same transaction), makes
// the one outside call and settles it: paid, failed (a person may retry), or unknown (Check
// pending reads it back). When the payout is confirmed with time left in the request, the
// QuickBooks post runs too (design D3); if not, the record page's button posts it later.
//
// Every state this leaves is one a later approval, retry or check adopts: a second approval finds
// the advance by its proposal and the ledger row by its key, so nothing is paid twice.
//
// Parked advances (flags.advanceParking, off until its own enable PR): while the switch is on, a
// person's approval whose numbers no longer hold when it runs parks the advance instead (its card
// is gone, the card statement names someone else, no room is left, or the approval went over a
// block or a mismatch), with nothing reserved and the proposal still approved. A person's next
// approval runs the same checks again: still short, it parks again with the new reason; clear, the
// same advances row goes on to requested and pays as attempt 1, the key it would have had without
// the park. A parked advance never has a ledger row. The autopilot never parks, releases or
// approves one: it keeps the fail path, and a parked row refuses it.

export type AdvanceDeps = ExecuteDeps & {
  // Ledger and adapter overrides (tests pass the mock adapter and short timeouts).
  money?: Partial<MoneyDeps>;
  // A monotonic clock for the request's time budget.
  steady?: () => number;
  newId?: () => string;
};

export type FlowResult =
  | { ok: true; advanceId: string; status: "paid" | "pending" | "posted"; moneyActionId: string }
  | { ok: false; category: string; retryable: boolean };

// The approve request's own budget; the QuickBooks leg runs only with enough of it left.
const REQUEST_BUDGET_MS = 25_000;
const NOTE_MAX = 240;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`advances: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

function steadyOf(deps: AdvanceDeps): () => number {
  return deps.steady ?? (() => performance.now());
}

// ---- The ledger hooks, shared by approval, retry and the reconcile pass ----

// In the reserve transaction: the advance becomes approved, naming the member whose approval
// reserved it, records the fuel card this attempt pays (every new attempt records its own), and
// the proposal records its first ledger row. The card must still be one of the driver's active
// cards and the driver must still be armed to receive money, asked here because this is the
// transaction the payout is reserved in. Must change the advance or throw; a throw rolls the
// reservation back.
async function onPayoutReserved(q: Queryable, action: MoneyAction, cardId: string | null): Promise<void> {
  if (!isCanonicalUuid(cardId)) throw new MoneyError("validation");
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'approved',
            decided_at = COALESCE(decided_at, CAST($3 AS timestamptz)),
            decided_by_membership_id = COALESCE(decided_by_membership_id, CAST($2 AS uuid)),
            card_id = CAST($4 AS uuid)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL
        AND status IN ('requested', 'approved')
        AND EXISTS (SELECT 1 FROM driver_cards c
                     WHERE c.tenant_id = current_tenant_id() AND c.id = CAST($4 AS uuid)
                       AND c.driver_id = advances.driver_id AND c.status = 'active')
        AND EXISTS (SELECT 1 FROM drivers d
                     WHERE d.tenant_id = current_tenant_id() AND d.id = advances.driver_id
                       AND d.money_armed)`,
    [action.subjectId, action.approverMembershipId, action.createdAt, cardId],
  );
  if (changed !== 1) throw new MoneyError("validation");
  if (action.proposalId) {
    await q.execute(
      `UPDATE proposals SET money_action_id = CAST($2 AS uuid), updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND money_action_id IS NULL`,
      [action.proposalId, action.id],
    );
  }
}

// In the settle transaction: the advance is paid as of the settle, and the proposal is done.
// A paid advance stays paid (a read-back after a lost reply lands here too). Anything else (an
// advance canceled while the money moved) throws, so the row stays open for a person.
async function onPayoutConfirmed(q: Queryable, action: MoneyAction): Promise<void> {
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'paid', paid_at = COALESCE(paid_at, CAST($2 AS timestamptz), now())
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL
        AND status IN ('approved', 'paid')`,
    [action.subjectId, action.settledAt],
  );
  if (changed !== 1) throw new MoneyError("validation");
  if (action.proposalId) {
    await q.execute(
      `UPDATE proposals SET status = 'done', updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [action.proposalId],
    );
  }
}

// A definite failure: no money moved. The advance stays approved (a person may retry it); the
// proposal ends as failed. After a later retry pays, the advance row is the truth (there is no
// failed-to-done transition for a proposal).
async function onPayoutFailed(q: Queryable, action: MoneyAction): Promise<void> {
  if (!action.proposalId) return;
  await q.execute(
    `UPDATE proposals SET status = 'failed', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [action.proposalId],
  );
}

// An advance proposal that ends without paying, with a note code the record says in words. Only
// from approved or executing, the two states the proposal guard lets move to failed; one already
// ended is left as it is. Returns the rows changed.
export function failAdvanceProposal(q: Queryable, proposalId: string, note: string, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'advance_payout'
        AND status IN ('approved', 'executing')`,
    [proposalId, note.slice(0, NOTE_MAX), nowIso],
  );
}

// The hooks for one payout attempt to the card resolved for it. A resumed row (reserved by an
// earlier request) never runs onReserved, so it passes no card and keeps the one it recorded;
// the destination is always read back by advances.card_id.
export function payoutHooksFor(cardId: string | null): MoneyHooks {
  return {
    onReserved: (q, action) => onPayoutReserved(q, action, cardId),
    onConfirmed: onPayoutConfirmed,
    onFailed: onPayoutFailed,
    destination: readCardDestination,
  };
}

export const payoutReconcileHooks: ReconcileHooks = {
  onConfirmed: onPayoutConfirmed,
  onFailed: onPayoutFailed,
  destination: readCardDestination,
};

// ---- Shared reads ----

async function memberRole(q: Queryable, session: Session): Promise<string | null> {
  await assertMembership(q, session);
  const rows = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  return rows.length === 1 ? rows[0].role : null;
}

const needsAdmin = (amountCents: number, role: string | null) =>
  amountCents > flags.approverRole.adminAboveCents && role !== "admin";

async function payoutRows(q: Queryable, advanceId: string): Promise<MoneyAction[]> {
  return (await readBySubject(q, "advances", advanceId)).filter((a) => a.kind === "advance_payout");
}

// Whether the driver is armed to receive money: null when there is no such driver here. Only
// true arms; the column is never null, and anything else reads as not armed.
async function driverArmed(q: Queryable, driverId: string, lock: boolean): Promise<boolean | null> {
  const rows = await q.query<{ money_armed: boolean }>(
    `SELECT money_armed FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${
      lock ? " FOR UPDATE" : ""
    }`,
    [driverId],
  );
  return rows.length === 1 ? rows[0].money_armed === true : null;
}

// The card and the load a proposal names, when it names them (validProposal has checked both are
// canonical ids or absent).
const namedCard = (p: ProposalRow): string | null => (isCanonicalUuid(p.args.cardId) ? p.args.cardId : null);
const namedLoad = (p: ProposalRow): string | null => (isCanonicalUuid(p.args.loadId) ? p.args.loadId : null);

// The card a flow advance's proposal named, for a retry; null when it named none.
async function proposalCard(q: Queryable, proposalId: string): Promise<string | null> {
  const rows = await q.query<{ card_id: string | null }>(
    `SELECT args ->> 'cardId' AS card_id FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [proposalId],
  );
  if (rows.length !== 1) throw new Stop("not_found");
  const cardId = rows[0].card_id;
  if (cardId === null) return null;
  // A malformed id never passed validProposal, so it never reached a payout; refuse it whole.
  if (!isCanonicalUuid(cardId)) throw new Stop("card_not_drivers");
  return cardId;
}

// Where the ask came from: the outside message the proposal names, when it is this tenant's.
async function sourceOf(
  q: Queryable,
  requestRef: unknown,
): Promise<{ source: ReturnType<typeof sourceOfInput>; inputId: string | null }> {
  if (!isCanonicalUuid(requestRef)) return { source: "ui", inputId: null };
  const rows = await q.query<{ kind: string }>(
    "SELECT kind FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [requestRef],
  );
  if (rows.length !== 1) return { source: "ui", inputId: null };
  return { source: sourceOfInput(rows[0].kind), inputId: requestRef };
}

function moneyRefusal(category: MoneyFailure, disabledAs: string) {
  if (category === "disabled") return no(disabledAs);
  if (category === "validation" || category === "duplicate") return no("unavailable");
  // The send happened and even the read of its row failed: money may have moved, so the outcome
  // is unknown and Check pending reads it back; never a retry. An adapter not ready for a reason
  // it cannot name lands here too; pending is the safe side of that.
  if (category === "unknown") return no("payout_pending");
  return no("unavailable", true);
}

function noteOf(decision: AdvanceDecision): string {
  const codes = decision.reasons.length > 0 ? decision.reasons.join(",") : "amount_changed";
  return `stale_eligibility: ${codes}`.slice(0, NOTE_MAX);
}

// ---- Approval ----

// overridden: the approval stored an auditor block's or an engine mismatch's override reason.
type ProposalLock = { status: string; createdAt: string; overridden: boolean };

type Prepared =
  // card: the driver's active card when this approval reserves a new ledger row; null when it
  // resumes a row an earlier request reserved (that row keeps the card it recorded).
  | { kind: "pay"; advance: FlowAdvance; attempt: number; card: CardOnFile | null }
  | { kind: "stale" }
  | { kind: "failed" }
  | { kind: "parked"; reason: ParkReason };

const absentOrId = (v: unknown) => v === undefined || v === null || isCanonicalUuid(v);

function validProposal(p: ProposalRow): boolean {
  return (
    p.kind === "advance_payout" &&
    p.subjectTable === "drivers" &&
    isCanonicalUuid(p.subjectId) &&
    p.args.driverId === p.subjectId &&
    Number.isSafeInteger(p.amountCents) &&
    p.amountCents > 0 &&
    p.args.amountCents === p.amountCents &&
    absentOrId(p.args.cardId) &&
    absentOrId(p.args.loadId)
  );
}

// The gate's early refusal for an advance (Precheck in src/lib/proposals/execute.ts), asked under
// the gate's proposal lock before the proposal becomes approved: a refusal leaves it waiting, with
// Approve still on its card. Reads only. It asks what the executor asks before the advances row
// exists: the advances switch, the proposal's shape, the payout gate on the tenant's local date,
// the driver and whether they are armed to receive money, the card it pays (the one the proposal
// names, never the default in its place, else the default), the load it names, and whether the
// pay rules can be read and run. The
// driver is read, not locked: the
// lock would end when the gate commits, before the executor's own transaction, which locks the
// driver itself. What the pay rules decide is left to the executor: a proposal whose numbers no
// longer hold must end failed with its reason, and only an approved proposal may become failed.
// The autopilot (ctx.opts.autopilot) is the exception: it never approves numbers that no longer
// hold, so for it a proposal the pay rules no longer allow to the cent is refused here as
// stale_eligibility and waits for a person. The executor asks all of this again after the
// approval, since a switch can change in between.
export async function precheckAdvanceProposal(
  q: Queryable,
  p: ProposalRow,
  now: Date,
  ctx?: PrecheckContext,
): Promise<ProposalRefused | null> {
  if (!advancesOn()) return no("disabled");
  if (!validProposal(p)) return no("not_executable");
  const nowIso = now.toISOString();
  const zone = await readTenantZone(q);
  const refusal = payoutGate(p.amountCents, localDateOf(nowIso, zone));
  if (refusal) return no(refusal);
  const armed = await driverArmed(q, p.subjectId, false);
  if (armed === null) return no("not_found");
  if (!armed) return no("driver_not_armed");
  const cardId = namedCard(p);
  if (!(await readPayoutCard(q, p.subjectId, cardId))) return no(cardId ? "card_not_drivers" : "no_card");
  const loadId = namedLoad(p);
  let input: Awaited<ReturnType<typeof readAdvanceInput>>;
  let decision: AdvanceDecision;
  try {
    input = await readAdvanceInput(q, p.subjectId, nowIso, p.amountCents, loadId);
    decision = advanceEligibility(input);
  } catch {
    return no("eligibility_unavailable", true);
  }
  if (loadId && !input.load) return no("load_not_drivers");
  if (ctx?.opts.autopilot !== undefined && !(decision.eligible && decision.approvedCents === p.amountCents)) {
    return no("stale_eligibility");
  }
  return null;
}

// Who approved: a person (staff or admin through the usual route) or the autopilot's login. Only
// a person's approval parks or releases an advance.
type Approver = { session: Session; person: boolean };

// The facts a park reason is picked from, read under the proposal and driver locks. The card is
// the one a new ledger row would pay (null when it is no longer on file); the name check runs only
// when there is a card; an unreadable eligibility read is unknown, never a park.
async function parkFacts(
  q: Queryable,
  p: ProposalRow,
  nowIso: string,
): Promise<{
  card: CardOnFile | null;
  decision: AdvanceDecision;
  input: Awaited<ReturnType<typeof readAdvanceInput>>;
  nameMatches: boolean | null;
}> {
  const card = await readPayoutCard(q, p.subjectId, namedCard(p));
  let decision: AdvanceDecision;
  let input: Awaited<ReturnType<typeof readAdvanceInput>>;
  try {
    input = await readAdvanceInput(q, p.subjectId, nowIso, p.amountCents, namedLoad(p));
    decision = advanceEligibility(input);
  } catch {
    throw new Stop("eligibility_unavailable", true);
  }
  if (namedLoad(p) && !input.load) throw new Stop("load_not_drivers");
  let nameMatches: boolean | null = null;
  if (card) {
    const facts = await readCardStatementName(q, p.subjectId, card.id);
    // The card was read a moment ago under the driver lock: a miss here is unknown, never a pass.
    if (!facts) throw new Stop("unavailable", true);
    nameMatches = facts.statementName === null ? null : cardNameMatches(facts);
  }
  return { card, decision, input, nameMatches };
}

const hasRoom = (p: ProposalRow, d: AdvanceDecision) => d.eligible && d.approvedCents === p.amountCents;

// The engine's first reason code, for a no_room park's reason_category; null for any other park.
function engineReasonOf(reason: ParkReason, d: AdvanceDecision): string | null {
  if (reason !== "no_room") return null;
  const first = d.reasons[0];
  return typeof first === "string" && /^[a-z_]{2,40}$/.test(first) ? first : null;
}

// Runs inside one tenant transaction, after the proposal gate moved the proposal to approved (or
// on a resume, with it approved or executing). Per the executor contract it never sets approved
// itself and asks no role or confirm question again: those passed under the gate's lock and the
// person's approval stands. It re-reads its own advance and ledger rows before any work. The one
// exception is a parked advance: approving it again is a new decision on a resume, so its role
// rules are asked here (see releaseParked).
async function prepare(
  q: Queryable,
  p: ProposalRow,
  now: Date,
  newId: () => string,
  who: Approver,
): Promise<Prepared> {
  const locked = await q.query<{ status: string; created_at: string; overridden: boolean }>(
    `SELECT status,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            (auditor_override_at IS NOT NULL OR engine_override_at IS NOT NULL) AS overridden
       FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'advance_payout'
      FOR UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const lock: ProposalLock = {
    status: locked[0].status,
    createdAt: locked[0].created_at,
    overridden: locked[0].overridden === true,
  };
  // A waiting proposal never reaches an executor; a decided one has nothing left to run.
  if (lock.status === "proposed") throw new Stop("not_executable");
  if (lock.status !== "approved" && lock.status !== "executing") throw new Stop("already_decided");

  const nowIso = now.toISOString();
  const zone = await readTenantZone(q);
  const refusal = payoutGate(p.amountCents, localDateOf(nowIso, zone));
  if (refusal) throw new Stop(refusal);
  // The arm state under the driver lock: arming takes the same lock, so it cannot change between
  // this read and the commit.
  const armed = await driverArmed(q, p.subjectId, true);
  if (armed === null) throw new Stop("not_found");
  if (!armed) throw new Stop("driver_not_armed");

  let advance = await readFlowAdvanceByProposal(q, p.id);
  if (advance?.status === "parked") return releaseParked(q, p, advance, lock, zone, nowIso, who);
  // Parking, asked now: only a person's approval, with the switch on for this proposal's date.
  const parking = who.person && parkingOn(lock.createdAt, zone);
  const rows = advance ? await payoutRows(q, advance.id) : [];
  const latest = rows.at(-1) ?? null;
  // A new ledger row pays the card the proposal names (never the default in its place) or else
  // the driver's default card, asked under the driver lock. A resume of a row already reserved
  // keeps the card that row recorded, so it is not asked for one.
  const cardId = namedCard(p);
  const card = latest === null ? await readPayoutCard(q, p.subjectId, cardId) : null;
  if (latest === null && !card) {
    // A requested advance whose card went before its first ledger row (the reserve refuses a card
    // no longer on file and rolls back): parked as card_removed instead of stopping on every press.
    if (parking && advance?.status === "requested") {
      await parkRequested(q, advance.id, nowIso);
      return { kind: "parked", reason: "card_removed" };
    }
    if (!parking || advance) throw new Stop(cardId ? "card_not_drivers" : "no_card");
  }

  if (!advance) {
    let decision: AdvanceDecision;
    let input: Awaited<ReturnType<typeof readAdvanceInput>>;
    let park: ParkReason | null = null;
    if (parking) {
      const facts = await parkFacts(q, p, nowIso);
      decision = facts.decision;
      input = facts.input;
      park = parkReasonOf({
        cardOnFile: facts.card !== null,
        nameMatches: facts.nameMatches,
        room: hasRoom(p, decision),
        overridden: lock.overridden,
      });
    } else {
      const loadId = namedLoad(p);
      try {
        input = await readAdvanceInput(q, p.subjectId, nowIso, p.amountCents, loadId);
        decision = advanceEligibility(input);
      } catch {
        throw new Stop("eligibility_unavailable", true);
      }
      if (loadId && !input.load) throw new Stop("load_not_drivers");
      if (!hasRoom(p, decision)) {
        // The numbers changed since the proposal: it is never paid. Written and returned (the
        // commit keeps the outcome), so the card and the record say why.
        await failAdvanceProposal(q, p.id, noteOf(decision), nowIso);
        return { kind: "stale" };
      }
    }
    const from = await sourceOf(q, p.args.requestRef);
    // A park writes the row parked, with its reason and time, and reserves nothing; the proposal
    // stays approved, so a person's next approval comes back here as a resume.
    await q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on,
                             amount_cents, fee_cents, status, source, proposal_id, source_input_id,
                             load_id, park_reason, parked_at, reason_category)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz),
               CAST($5 AS date), $6, $7, $12, $8, CAST($9 AS uuid), CAST($10 AS uuid),
               CAST($11 AS uuid), $13, CAST($14 AS timestamptz), $15)
       ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
      [
        newId(),
        p.subjectId,
        requestRefOf(p.id),
        lock.createdAt,
        localDateOf(lock.createdAt, zone),
        p.amountCents,
        decision.feeCents,
        from.source,
        p.id,
        from.inputId,
        input.load?.id ?? null,
        park ? "parked" : "requested",
        park,
        park ? nowIso : null,
        park ? engineReasonOf(park, decision) : null,
      ],
    );
    advance = await readFlowAdvanceByProposal(q, p.id);
    if (!advance) throw new DbError("unknown");
    // Under the proposal lock no other request can have written the row in between.
    if ((advance.status === "parked") !== (park !== null)) throw new DbError("unknown");
    if (park) return { kind: "parked", reason: park };
  }
  return carryOn(q, p, advance, lock, latest, card, nowIso);
}

// From here an advance goes ahead: the proposal moves on to executing and the payout is reserved
// (or resumed by its key).
async function carryOn(
  q: Queryable,
  p: ProposalRow,
  advance: FlowAdvance,
  lock: ProposalLock,
  latest: MoneyAction | null,
  card: CardOnFile | null,
  nowIso: string,
): Promise<Prepared> {
  if (lock.status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  if (advance.status === "rejected" || advance.status === "cancelled") throw new Stop("already_decided");
  if (latest?.state === "failed") {
    // A definite failure ends the approval; a person retries from the advance's page.
    await onPayoutFailed(q, latest);
    return { kind: "failed" };
  }
  return { kind: "pay", advance, attempt: latest ? latest.attempt : 1, card };
}

// No ledger row for this advance: the one condition every park and release writes under.
const NO_LEDGER_ROW = `NOT EXISTS (SELECT 1 FROM money_actions m
                                    WHERE m.tenant_id = advances.tenant_id AND m.subject_table = 'advances'
                                      AND m.subject_id = advances.id)`;

async function parkRequested(q: Queryable, advanceId: string, nowIso: string): Promise<void> {
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'parked', park_reason = 'card_removed', parked_at = CAST($2 AS timestamptz),
            reason_category = NULL
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND proposal_id IS NOT NULL
        AND status = 'requested' AND ${NO_LEDGER_ROW}`,
    [advanceId, nowIso],
  );
  if (changed !== 1) throw new DbError("unknown");
}

// A person approves a parked advance again. The autopilot never does; with the switch off nothing
// is released (a reject still is). The role rules are asked again, as a retry asks them: an amount
// over the admin line needs an admin, and so does any approval that went over a block or a
// mismatch (the override itself is not asked again, or no press could ever clear it). Then the
// same checks as the first approval: still short, the advance parks again with the reason found
// now; clear, it goes on to requested, keeping its id, so its payout is attempt 1 under the key it
// would have had without the park.
async function releaseParked(
  q: Queryable,
  p: ProposalRow,
  advance: FlowAdvance,
  lock: ProposalLock,
  zone: string,
  nowIso: string,
  who: Approver,
): Promise<Prepared> {
  if (!who.person) throw new Stop("autopilot_only");
  if (!parkingOn(lock.createdAt, zone)) throw new Stop("parking_off");
  // A parked advance never has a ledger row; one found here is a state no path writes.
  if ((await payoutRows(q, advance.id)).length > 0) throw new Stop("unavailable");
  const role = await memberRole(q, who.session);
  if (needsAdmin(p.amountCents, role)) throw new Stop("role");
  if (lock.overridden && role !== "admin") throw new Stop("parked_needs_admin");
  const facts = await parkFacts(q, p, nowIso);
  const park = parkReasonOf({
    cardOnFile: facts.card !== null,
    nameMatches: facts.nameMatches,
    room: hasRoom(p, facts.decision),
    overridden: false,
  });
  if (park) {
    const changed = await q.execute(
      `UPDATE advances
          SET park_reason = $2, parked_at = CAST($3 AS timestamptz), reason_category = $4, fee_cents = $5
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'parked'`,
      [advance.id, park, nowIso, engineReasonOf(park, facts.decision), facts.decision.feeCents],
    );
    if (changed !== 1) throw new DbError("unknown");
    return { kind: "parked", reason: park };
  }
  const changed = await q.execute(
    `UPDATE advances
        SET status = 'requested', reason_category = NULL, fee_cents = $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'parked'
        AND ${NO_LEDGER_ROW}`,
    [advance.id, facts.decision.feeCents],
  );
  if (changed !== 1) throw new DbError("unknown");
  const released = await readFlowAdvanceByProposal(q, p.id);
  if (!released || released.id !== advance.id || released.status !== "requested") throw new DbError("unknown");
  return carryOn(q, p, released, lock, null, facts.card, nowIso);
}

export async function executeAdvanceProposal(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  opts: ApproveOptions,
  deps: AdvanceDeps,
): Promise<ProposalResult> {
  if (!advancesOn()) return no("disabled");
  if (!validProposal(proposal)) return no("not_executable");
  const steady = steadyOf(deps);
  const started = steady();
  const now = (deps.clock ?? (() => new Date()))();
  const newId = deps.newId ?? randomUUID;

  let prepared: Prepared;
  try {
    // A person's approval, never the autopilot's: both are asked, the way the gate asks them.
    const who: Approver = { session, person: opts.autopilot === undefined && !isAutopilotSub(session.sub) };
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, proposal, now, newId, who));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    if (err instanceof DbError && err.sqlState === "23505") return no("ref_collision");
    throw err;
  }
  if (prepared.kind === "stale") return no("stale_eligibility");
  if (prepared.kind === "failed") return no("payout_failed", true);
  // Written and committed: the advance waits, parked with its reason, for a person.
  if (prepared.kind === "parked") return no(`parked_${prepared.reason}`);
  const { advance, attempt, card } = prepared;
  if (advance.status === "paid") {
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: proposal.moneyActionId };
  }

  const paid = await pay(db, session, advance, attempt, proposal.traceId, deps, "payouts_off", card);
  if (!paid.ok) return paid;
  if (paid.state === "confirmed") {
    await legTwo(db, session, advance.id, deps, REQUEST_BUDGET_MS - (steady() - started));
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: paid.actionId };
  }
  return { ok: true, proposalId: proposal.id, status: "executing", moneyActionId: paid.actionId };
}

type Paid =
  | { ok: true; state: "confirmed" | "pending"; actionId: string }
  | { ok: false; category: string; retryable: boolean };

async function pay(
  db: TenantDb,
  session: Session,
  advance: FlowAdvance,
  attempt: number,
  traceId: string | null,
  deps: AdvanceDeps,
  disabledAs: string,
  card: CardOnFile | null,
): Promise<Paid> {
  // The payout gate once more, right before the money executor: both callers asked it in an
  // earlier transaction, and the executor itself re-checks only payoutsEnabled and the adapter,
  // not armed, the cap or the start date. A refusal here is a definite no with nothing reserved,
  // and so is a gate that cannot be read.
  let refusal: PayoutRefusal | null;
  try {
    const now = (deps.clock ?? (() => new Date()))();
    const zone = await db.withTenant(session.tenantId, (q) => readTenantZone(q));
    refusal = payoutGate(advance.amountCents, localDateOf(now.toISOString(), zone));
  } catch (err) {
    console.error("advance payout gate could not be read:", err instanceof Error ? err.name : "unknown");
    return no("unavailable", true);
  }
  if (refusal) return no(refusal);
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "advance_payout",
        subjectId: advance.id,
        counterpartyId: advance.driverId,
        amountCents: advance.amountCents,
        attempt,
        proposedBy: "agent",
        proposalId: advance.proposalId,
        traceId: isCanonicalUuid(traceId) ? traceId : null,
        subjectStatuses: ["requested", "approved"],
      },
      payoutHooksFor(card?.id ?? null),
      deps.money,
    );
    if (r.action.state === "confirmed") return { ok: true, state: "confirmed", actionId: r.action.id };
    if (r.action.state === "failed") return no("payout_failed", r.action.failureCategory !== "amount_mismatch");
    return { ok: true, state: "pending", actionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) return moneyRefusal(err.category, disabledAs);
    if (err instanceof Error && err.name === "ForbiddenError") throw err;
    console.error("advance payout did not finish:", err instanceof Error ? err.name : "unknown");
    // Not always before a send: a read of the row can fail while this request waits on another
    // that holds the send, so money may have moved. Unknown, never a retry.
    return no("payout_pending");
  }
}

// The QuickBooks leg after a confirmed payout, inside the same request when the switch is on and
// time is left. Its outcome never changes the payout's: a post left undone shows as pending on
// the advance's page, with a button. Its outside call is limited to the request's time left less
// a second, and never longer than the money executor's own limit, so it cannot outrun the request.
export function legTwoTimeoutMs(remainingMs: number, configuredMs: number | undefined): number {
  return Math.min(Math.floor(remainingMs) - 1_000, configuredMs ?? DEFAULT_TIMEOUT_MS);
}

async function legTwo(
  db: TenantDb,
  session: Session,
  advanceId: string,
  deps: AdvanceDeps,
  remainingMs: number,
): Promise<void> {
  if (flags.accountingEnabled !== true) return;
  if (remainingMs <= flags.advancesLimits.legTwoMinRemainingMs) return;
  const timeoutMs = legTwoTimeoutMs(remainingMs, deps.money?.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return;
  try {
    await postAdvanceExpense(session, advanceId, {
      ...deps,
      db,
      onlyFirst: true,
      money: { ...deps.money, timeoutMs },
    });
  } catch (err) {
    console.error("advance post did not finish:", err instanceof Error ? err.name : "unknown");
  }
}

// ---- Retry and check ----

// A person retries a payout that definitely failed, as the next attempt, or sends the first one
// when the approval stopped before it. Unknown or still-sent payouts are never retried (they may
// have paid): Check pending reads them back instead.
export async function retryAdvancePayout(
  session: Session,
  advanceId: string,
  deps: AdvanceDeps = {},
): Promise<FlowResult> {
  if (!advancesOn()) return no("disabled");
  const db = deps.db ?? getDb();
  const steady = steadyOf(deps);
  const started = steady();
  const now = (deps.clock ?? (() => new Date()))();
  let picked: { advance: FlowAdvance; attempt: number; traceId: string | null; card: CardOnFile };
  try {
    picked = await db.withTenant(session.tenantId, async (q) => {
      const role = await memberRole(q, session);
      const advance = await readFlowAdvance(q, advanceId, true);
      if (!advance) throw new Stop("not_found");
      const latest = (await payoutRows(q, advance.id)).at(-1) ?? null;
      // An approved advance after a definite failure, or a requested one whose approval stopped
      // before its first ledger row (the payment service was not ready): a person approved both.
      if (advance.status !== "approved" && !(advance.status === "requested" && latest === null)) {
        throw new Stop("not_retryable");
      }
      let attempt = 1;
      if (latest) {
        if (latest.state === "reserved" || latest.state === "sent" || latest.state === "unknown") {
          throw new Stop("payout_pending");
        }
        if (latest.state !== "failed" || latest.failureCategory === "amount_mismatch") {
          throw new Stop("not_retryable");
        }
        attempt = latest.attempt + 1;
      }
      if (attempt > flags.advancesLimits.maxPayoutAttempts || attempt > MAX_ATTEMPT) {
        throw new Stop("attempts_exhausted");
      }
      if (needsAdmin(advance.amountCents, role)) throw new Stop("role");
      const zone = await readTenantZone(q);
      const refusal = payoutGate(advance.amountCents, localDateOf(now.toISOString(), zone));
      if (refusal) throw new Stop(refusal);
      // Armed, asked under the driver lock (the reserve asks it once more).
      const armed = await driverArmed(q, advance.driverId, true);
      if (armed === null) throw new Stop("not_found");
      if (!armed) throw new Stop("driver_not_armed");
      // The card the proposal named, refused once it is no longer one of the driver's active cards
      // (never swapped for the default); with none named, the driver's current default, not the
      // failed attempt's: a declined card is usually the one being replaced. The new attempt
      // records the card it pays.
      const cardId = await proposalCard(q, advance.proposalId);
      const card = await readPayoutCard(q, advance.driverId, cardId);
      if (!card) throw new Stop(cardId ? "card_not_drivers" : "no_card");
      return { advance, attempt, traceId: latest?.traceId ?? null, card };
    });
  } catch (err) {
    if (err instanceof Stop) return err.result;
    throw err;
  }
  const paid = await pay(
    db,
    session,
    picked.advance,
    picked.attempt,
    picked.traceId,
    deps,
    "payouts_off",
    picked.card,
  );
  if (!paid.ok) return paid;
  if (paid.state === "confirmed") {
    await legTwo(db, session, picked.advance.id, deps, REQUEST_BUDGET_MS - (steady() - started));
    return { ok: true, advanceId: picked.advance.id, status: "paid", moneyActionId: paid.actionId };
  }
  return { ok: true, advanceId: picked.advance.id, status: "pending", moneyActionId: paid.actionId };
}

// The reconcile pass reads back a row still sent only once it is this old (an unknown row at
// once), so a send still in flight is not read back as if it had been lost.
const CHECK_AFTER_SECONDS = 60;

export type CheckResult =
  // tooNew: this advance's rows still sent too recently for the pass to read back. stillWaiting:
  // its other rows still sent or unknown that the pass did not settle. Both are counted only when
  // the pass checked nothing, so the notice says what is still waiting, never "nothing".
  | { ok: true; summary: ReconcileSummary; tooNew: number; stillWaiting: number }
  | { ok: false; category: string; retryable: boolean };

// Check pending: the reconcile pass over this advance's own open payouts and posts (each read back
// by its request id), so the check and its notice cover only this advance. Never sends anything
// new; a payout found paid gets the same follow-up write the approval would have made. A person
// asked, so the pass reads this advance's rows back even past the automatic check limit; the
// read stays read-only and only a definite answer moves a row.
export async function checkAdvancePayouts(
  session: Session,
  advanceId: string,
  deps: AdvanceDeps = {},
): Promise<CheckResult> {
  if (!advancesOn()) return no("disabled");
  const db = deps.db ?? getDb();
  // The button lives on one advance's page: it must be this carrier's flow advance.
  const found = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return readFlowAdvance(q, advanceId);
  });
  if (!found) return no("not_found");
  const summary = await reconcileMoneyActions(
    db,
    session,
    {
      hooks: {
        advance_payout: payoutReconcileHooks,
        advance_expense: expenseReconcileHooks(db, session.tenantId, deps.money),
      },
      limit: 5,
      olderThanSeconds: CHECK_AFTER_SECONDS,
      subject: { table: "advances", id: found.id },
      ignoreCheckLimit: true,
    },
    deps.money,
  );
  // By the database's clock, the one the pass's window uses. A row the pass read back is no
  // longer sent, so only rows it left for later are counted.
  let tooNew = 0;
  let stillWaiting = 0;
  if (summary.checked === 0) {
    const rows = await db.withTenant(session.tenantId, (q) => readBySubject(q, "advances", found.id));
    for (const a of rows) {
      if (a.state === "sent" && a.sentSecondsAgo !== null && a.sentSecondsAgo <= CHECK_AFTER_SECONDS) tooNew += 1;
      else if (a.state === "sent" || a.state === "unknown") stillWaiting += 1;
    }
  }
  return { ok: true, summary, tooNew, stillWaiting };
}
