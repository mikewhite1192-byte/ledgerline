import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { cardPuller } from "../adapters";
import type { CardPuller, CardPullRequest, FuelCardDestination } from "../adapters/types";
import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import { isAutopilotSub } from "../autopilot/session";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { dollars } from "../money/format";
import { isCanonicalUuid, memoCodeOf } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MoneyError, type MoneyAction } from "../money/types";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  Precheck,
  ProposalResult,
  ProposalRow,
} from "../proposals/execute";
import { isServiceSub } from "../sweep/service-session";
import { assertMembership, ForbiddenError } from "../tenant/context";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import { isPullbackReason, planPull, readPullDestination, samePull, type PullPlanned } from "./facts";
import { readPull, type PullRow } from "./read";
import { pullbackOn, pullGate } from "./switches";

// A person approves a card_pullback proposal, and only then is money pulled back off the driver's
// fuel card (S6 design 4.1). The proposal gate (src/lib/proposals/execute.ts) has checked the
// person, the role (an amount above approverRole.adminAboveCents needs an admin), the auditor and
// the second confirm, and asked precheckCardPullback while the proposal still waited. Then, in one
// tenant transaction with the proposal locked (and, for a new pull, the driver and the advance),
// this executor asks the pull gate again, plans the pull again from live facts (the balance, the
// advance, the card: a plan that is not the card's ends the proposal failed, nothing sent), writes
// the card_pullbacks row as 'issuing' (one per proposal: card_pullbacks_one_per_proposal; one live
// per driver: card_pullbacks_one_live_per_driver; one live or done per advance:
// card_pullbacks_one_per_advance) and moves the proposal to executing. The money executor then
// reserves the ledger row (idempotency key card_pullback:<pull id>:1, request id = the row id
// without dashes), the reserve asking the pull gate once more, makes the one pull through the
// simulated card provider (test mode only; no real provider exists) and settles it:
//   confirmed  finishPull, in the settle transaction: the pull 'pulled' with its time; a take-back
//              records the pulled cents on the advance (guarded on the advance still paid, not
//              taken back and inside its bound); a breakdown with a shortfall books it as a named
//              deficit; the proposal done. An advance that moved meanwhile is never written past
//              its bound: the pull is marked 'unknown' for a person and a log line names it by id
//   failed     the pull 'failed' and the proposal failed; nothing moved. A provider that confirmed
//              another amount (amount_mismatch) is not a failure: money moved, so the pull is
//              marked 'unknown' for a person and stays live
//   unknown    the pull stays 'issuing' until Check pending reads the row back by its request id
//              and settles it (the same finishPull), never a second pull
// The same proposal approved twice, or run again, finds its pull by proposal id and replays the
// same ledger row by its key, so one pull makes one call. A retry after a failure is a new
// proposal, a new pull row and a new ledger row; the failed one stays as the record.
// Never the autopilot's and never the sweep's login: a named person approves (the gate and the
// autopilot's policy refuse them too; this is its own wall).

export type PullbackDeps = ExecuteDeps & {
  money?: Partial<MoneyDeps>;
  newId?: () => string;
  puller?: CardPuller;
};

const NOTE_MAX = 240;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`card pull-back: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

export const nowOf = (deps: { clock?: () => Date }): Date => (deps.clock ?? (() => new Date()))();

// A named person, never a login that acts by itself.
const machineLogin = (session: Session): boolean => isAutopilotSub(session.sub) || isServiceSub(session.sub);

// ---- The proposal's args ----

// The proposal's args read whole: the subject is the advance taken back (advances) or, on a
// breakdown, the driver (drivers); the amount is what was asked for; every number a safe integer.
export function pullArgsOf(p: Pick<ProposalRow, "kind" | "subjectTable" | "subjectId" | "amountCents" | "args">): PullPlanned | null {
  const a = p.args;
  if (p.kind !== "card_pullback" || !a || typeof a !== "object") return null;
  const ints = [a.requestedCents, a.balanceCents, a.pullCents, a.shortfallCents];
  if (!ints.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  if (
    typeof a.driverId !== "string" ||
    !isCanonicalUuid(a.driverId) ||
    typeof a.cardId !== "string" ||
    !isCanonicalUuid(a.cardId) ||
    typeof a.cardLast4 !== "string" ||
    !/^[0-9]{4}$/.test(a.cardLast4) ||
    !(a.advanceId === null || (typeof a.advanceId === "string" && isCanonicalUuid(a.advanceId))) ||
    !isPullbackReason(a.reason) ||
    typeof a.balanceAsOf !== "string" ||
    !isLocalDate(a.balanceAsOf)
  ) {
    return null;
  }
  const advanceId = a.advanceId === null ? null : (a.advanceId as string).toLowerCase();
  const subjectOk =
    advanceId === null
      ? p.subjectTable === "drivers" && p.subjectId.toLowerCase() === a.driverId.toLowerCase()
      : p.subjectTable === "advances" && p.subjectId.toLowerCase() === advanceId;
  const plan: PullPlanned = {
    driverId: a.driverId.toLowerCase(),
    cardId: a.cardId.toLowerCase(),
    cardLast4: a.cardLast4,
    advanceId,
    reason: a.reason,
    requestedCents: a.requestedCents as number,
    balanceCents: a.balanceCents as number,
    pullCents: a.pullCents as number,
    shortfallCents: a.shortfallCents as number,
    balanceAsOf: a.balanceAsOf,
  };
  // The engine's own shape: something to pull, never above what was asked or the balance; a
  // breakdown's shortfall is the rest, a take-back has none.
  const shaped =
    plan.requestedCents > 0 &&
    plan.pullCents > 0 &&
    plan.pullCents <= plan.requestedCents &&
    plan.pullCents <= plan.balanceCents &&
    (advanceId === null ? plan.pullCents + plan.shortfallCents === plan.requestedCents : plan.shortfallCents === 0);
  if (!subjectOk || !shaped || p.amountCents !== plan.requestedCents) return null;
  return plan;
}

// The plan's and the facts' refusals in the approval's words: anything that moved since the card
// was made (the balance, the advance, the card) is stale.
function factCategory(refusal: string): string {
  if (refusal === "bad_request") return "not_executable";
  if (refusal === "not_found") return "not_found";
  return "stale";
}

// ---- Shared reads and writes ----

async function pullRows(q: Queryable, pullId: string): Promise<MoneyAction[]> {
  return (await readBySubject(q, "card_pullbacks", pullId)).filter((a) => a.kind === "card_pullback");
}

// The carrier's local date a proposal was made, for the start date. Null when it does not read.
async function createdOnOf(q: Queryable, proposalId: string): Promise<LocalDate | null> {
  const rows = await q.query<{ created_at: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [proposalId],
  );
  if (rows.length !== 1) return null;
  return localDateOf(rows[0].created_at, await readTenantZone(q));
}

// Staff or admin, never a judge; any refusal or unreadable role is null.
async function staffRole(q: Queryable, session: Session): Promise<string | null> {
  try {
    return await requireStaff(q, session);
  } catch (err) {
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

// The approver rule's line on what is pulled, the executor's own wall on top of the gate's line on
// what was asked for: above it, only an admin.
const needsAdmin = (pullCents: number, role: string): boolean =>
  pullCents > flags.approverRole.adminAboveCents && role !== "admin";

// A card_pullback proposal that ends without a pull, with a note code the record says in words.
// Only from approved or executing, the two states the proposal guard lets move to failed.
function failProposal(q: Queryable, proposalId: string, note: string, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'card_pullback'
        AND status IN ('approved', 'executing')`,
    [proposalId, note.slice(0, NOTE_MAX), nowIso],
  );
}

async function closeProposal(q: Queryable, proposalId: string | null): Promise<void> {
  if (!proposalId) return;
  await q.execute(
    `UPDATE proposals SET status = 'done', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [proposalId],
  );
}

// The membership of the person who approved the proposal (decided_by is their login), so the
// record names them even when another person's Check pending settles it. Null when none.
async function approverOf(q: Queryable, proposalId: string): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    `SELECT CAST(m.id AS text) AS id FROM proposals p
       JOIN memberships m ON m.tenant_id = p.tenant_id AND m.cognito_sub = p.decided_by
      WHERE p.tenant_id = current_tenant_id() AND p.id = CAST($1 AS uuid)`,
    [proposalId],
  );
  return rows.length === 1 ? rows[0].id : null;
}

// Marks a pull whose money moved but whose record could not be finished: a person settles it, and
// the proposal stays executing. Ids only in the log.
async function markUnknown(q: Queryable, pullId: string, why: string): Promise<void> {
  await q.execute(
    `UPDATE card_pullbacks SET status = 'unknown', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
    [pullId],
  );
  console.error(`card pull-back ${pullId}: ${why}; marked unknown`);
}

// The breakdown deficit's note: the card's last four, what it held and what was asked for.
export function shortfallNote(last4: string, pulledCents: number, requestedCents: number): string {
  return `Breakdown pull-back: card ending ${last4} held ${dollars(pulledCents)} of ${dollars(requestedCents)}.`;
}

// One deficit for the shortfall: written once, read back whole, and adopted on a resume.
async function bookShortfall(
  q: Queryable,
  pull: PullRow,
  last4: string,
  namedBy: string,
  nowIso: string,
): Promise<boolean> {
  await q.execute(
    `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id,
                                  named_by, proposal_id, created_at)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, 'pullback_shortfall',
             CAST($4 AS uuid), CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS timestamptz))
     ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
    [
      pull.driverId,
      pull.shortfallCents,
      shortfallNote(last4, pull.pullCents, pull.requestedCents),
      pull.id,
      namedBy,
      pull.proposalId,
      nowIso,
    ],
  );
  const rows = await q.query<{ driver_id: string; amount_cents: string; source_kind: string; source_id: string }>(
    `SELECT CAST(driver_id AS text) AS driver_id, CAST(amount_cents AS text) AS amount_cents, source_kind,
            CAST(source_id AS text) AS source_id
       FROM driver_deficits WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
    [pull.proposalId],
  );
  return (
    rows.length === 1 &&
    rows[0].driver_id.toLowerCase() === pull.driverId &&
    Number(rows[0].amount_cents) === pull.shortfallCents &&
    rows[0].source_kind === "pullback_shortfall" &&
    rows[0].source_id.toLowerCase() === pull.id
  );
}

// The last four the card showed, from the proposal's args, for the deficit's note.
async function last4Of(q: Queryable, proposalId: string): Promise<string | null> {
  const rows = await q.query<{ last4: string | null }>(
    `SELECT args ->> 'cardLast4' AS last4 FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [proposalId],
  );
  const v = rows[0]?.last4;
  return typeof v === "string" && /^[0-9]{4}$/.test(v) ? v : null;
}

// ---- The ledger hooks ----

// The provider's request, pure from the stored ledger row and the card it names.
function requestOf(action: MoneyAction, destination: FuelCardDestination): CardPullRequest {
  return {
    actionId: action.id,
    driverId: action.counterpartyId,
    amountCents: action.amountCents,
    memoCode: memoCodeOf(action),
    destination,
  };
}

// In the reserve transaction: the pull gate once more (a switch turned off since the approval rolls
// the reservation back, nothing sent), then the pull names its ledger row and the proposal records
// its first. The pull must still be issuing with no row; a throw rolls the reservation back.
async function onPullReserved(q: Queryable, action: MoneyAction, createdOn: LocalDate): Promise<void> {
  if (pullGate(createdOn) !== null) throw new MoneyError("disabled");
  const changed = await q.execute(
    `UPDATE card_pullbacks SET money_action_id = CAST($2 AS uuid), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'
        AND money_action_id IS NULL`,
    [action.subjectId, action.id],
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

// The post-confirm step, in the settle transaction (the executor's or Check pending's).
// Idempotent: the pull row is locked first, a pulled one is left as it is (only its proposal is
// closed), and an unknown one stays for a person. A take-back's advance update is guarded on the
// advance still paid, not taken back and inside its bound, so it never takes back more than was
// owed. nowIso is the caller's clock, written as the pull time.
export async function finishPull(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  if (action.kind !== "card_pullback" || action.state !== "confirmed") throw new MoneyError("validation");
  const pull = await readPull(q, "id", action.subjectId, true);
  if (!pull || pull.driverId !== action.counterpartyId || pull.pullCents !== action.amountCents) {
    throw new MoneyError("validation");
  }
  if (pull.status === "pulled") {
    await closeProposal(q, action.proposalId);
    return;
  }
  if (pull.status === "unknown") return;
  // A failed pull with a confirmed ledger row is not something this step can settle: the throw
  // keeps the ledger row open for a person.
  if (pull.status !== "issuing") throw new MoneyError("validation");
  if (!Number.isFinite(Date.parse(nowIso))) throw new MoneyError("validation");
  // The approver is read only where a write names them (the advance, the deficit); a breakdown
  // with no shortfall writes neither and settles without it.
  if (pull.advanceId !== null) {
    const approver = await approverOf(q, pull.proposalId);
    if (approver === null) {
      await markUnknown(q, pull.id, "the approver's membership did not read");
      return;
    }
    const moved = await q.execute(
      `UPDATE advances
          SET taken_back_cents = taken_back_cents + $2, taken_back_at = CAST($3 AS timestamptz),
              taken_back_by_membership_id = CAST($4 AS uuid), takeback_reason = $5
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($6 AS uuid)
          AND status = 'paid' AND taken_back_at IS NULL
          AND recovered_cents + taken_back_cents + $2 <= amount_cents + fee_cents`,
      [pull.advanceId, pull.pullCents, nowIso, approver, pull.reason, pull.driverId],
    );
    if (moved !== 1) {
      await markUnknown(q, pull.id, "the advance moved before the pull settled");
      return;
    }
  } else if (pull.shortfallCents > 0) {
    const approver = await approverOf(q, pull.proposalId);
    if (approver === null) {
      await markUnknown(q, pull.id, "the approver's membership did not read");
      return;
    }
    const last4 = await last4Of(q, pull.proposalId);
    if (last4 === null || !(await bookShortfall(q, pull, last4, approver, nowIso))) {
      // Another row holds this proposal's deficit with other values: never adopted, never doubled.
      throw new MoneyError("validation");
    }
  }
  const changed = await q.execute(
    `UPDATE card_pullbacks
        SET status = 'pulled', pulled_at = CAST($2 AS timestamptz),
            money_action_id = COALESCE(money_action_id, CAST($3 AS uuid)), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
    [pull.id, nowIso, action.id],
  );
  if (changed !== 1) throw new MoneyError("validation");
  await closeProposal(q, action.proposalId);
}

// A definite failure: nothing was pulled. The pull ends failed and so does its proposal, stamped
// with the caller's clock. The advance and the deficits are never touched. A row failed as
// amount_mismatch is the one exception: the provider confirmed a pull of another amount, so money
// moved. The pull is marked unknown for a person (it stays live under the one-live indexes) and the
// proposal stays executing.
async function onPullFailed(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  if (action.failureCategory === "amount_mismatch") {
    await markUnknown(q, action.subjectId, "the provider confirmed a different amount");
    return;
  }
  await q.execute(
    `UPDATE card_pullbacks SET status = 'failed', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
    [action.subjectId],
  );
  if (action.proposalId) {
    await failProposal(q, action.proposalId, `pull_failed: ${action.failureCategory ?? "unknown"}`, nowIso);
  }
}

// A pull is a hooked payment kind (no payout rail): the card provider's own member sends it, so the
// hooks carry the send, the ready check and the caller's writes.
function pullHooks(puller: CardPuller, destination: FuelCardDestination, createdOn: LocalDate, nowIso: string): MoneyHooks {
  return {
    onReserved: (q, action) => onPullReserved(q, action, createdOn),
    onConfirmed: (q, action) => finishPull(q, action, nowIso),
    onFailed: (q, action) => onPullFailed(q, action, nowIso),
    ready: () => puller.ready(),
    // The feature switch at the write, on top of the money executor's payoutsEnabled; the provider
    // asks both again itself.
    send: async (action, ctx) => {
      if (!pullbackOn()) return { kind: "failed", category: "disabled" };
      return puller.pullBack(requestOf(action, destination), ctx);
    },
  };
}

export function pullReconcileHooks(puller: CardPuller, destination: FuelCardDestination, nowIso: string): ReconcileHooks {
  return {
    onConfirmed: (q, action) => finishPull(q, action, nowIso),
    onFailed: (q, action) => onPullFailed(q, action, nowIso),
    ready: () => puller.ready(),
    readBack: (action, ctx) =>
      puller.readBackPull(
        { requestId: action.requestId, outsideId: action.outsideId, request: requestOf(action, destination) },
        ctx,
      ),
  };
}

// ---- Approval ----

// The gate's early refusal (Precheck in src/lib/proposals/execute.ts), under the gate's proposal
// lock before the proposal becomes approved: a refusal leaves it waiting, with nothing written.
// Reads only, against live data: the plan made again must be the card's whole, or it is stale.
// The executor asks all of it again after the approval.
export const precheckCardPullback: Precheck = async (q, p, now, ctx) => {
  if (!pullbackOn()) return no("pullback_off");
  if (p.kind !== "card_pullback" || !ctx) return no("not_executable");
  if (machineLogin(ctx.session)) return no("kind_never_alone");
  const role = await staffRole(q, ctx.session);
  if (role === null) return no("role");
  const a = pullArgsOf(p);
  if (!a) return no("not_executable");
  if (needsAdmin(a.pullCents, role)) return no("role");
  const createdOn = await createdOnOf(q, p.id);
  if (createdOn === null) return no("not_executable");
  const refusal = pullGate(createdOn);
  if (refusal) return no(refusal === "pullback_before_start" ? "not_executable" : refusal);
  if (await readPull(q, "proposal_id", p.id)) return no("pull_exists");
  const facts = await planPull(q, a, flags.advanceTakeback.maxCents, now, { exceptProposalId: p.id });
  if (!facts.ok) return no(factCategory(facts.refusal));
  if (!samePull(facts.plan, a)) return no("stale");
  return null;
};

type Prepared =
  | { kind: "issue"; pull: PullRow; attempt: number; createdOn: LocalDate }
  | { kind: "done"; moneyActionId: string | null }
  | { kind: "refused"; category: string }
  | { kind: "failed"; category: string };

async function prepare(
  q: Queryable,
  session: Session,
  p: ProposalRow,
  a: PullPlanned,
  now: Date,
  newId: () => string,
): Promise<Prepared> {
  await assertMembership(q, session);
  const locked = await q.query<{ status: string }>(
    `SELECT status FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'card_pullback'
      FOR UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const status = locked[0].status;
  if (status === "proposed") throw new Stop("not_executable");
  if (status !== "approved" && status !== "executing") throw new Stop("already_decided");
  const role = await staffRole(q, session);
  if (role === null || needsAdmin(a.pullCents, role)) throw new Stop("role");

  const nowIso = now.toISOString();
  const createdOn = await createdOnOf(q, p.id);
  if (createdOn === null) throw new Stop("not_executable");
  const refusal = pullGate(createdOn);
  if (refusal) throw new Stop(refusal === "pullback_before_start" ? "not_executable" : refusal);

  // The pull row is read, never locked, here: the reserve and settle transactions lock the pull
  // first and then the advance or the proposal, and this one already holds the proposal. The
  // proposal lock serializes approvals; the reserve locks the pull and asks its status again.
  let pull = await readPull(q, "proposal_id", p.id);
  if (!pull) {
    // A new pull: the driver's and the advance's row locks hold the facts until this commits. A
    // resume (the pull already written) takes neither lock, for the same cycle.
    const facts = await planPull(q, a, flags.advanceTakeback.maxCents, now, { lock: true, exceptProposalId: p.id });
    if (!facts.ok || !samePull(facts.plan, a)) {
      // The facts changed since the card: no pull. Written and returned (the commit keeps it), so
      // the card and the record say why.
      const category = facts.ok ? "stale" : factCategory(facts.refusal);
      await failProposal(q, p.id, `refused: ${category}`, nowIso);
      return { kind: "refused", category };
    }
    await q.execute(
      `INSERT INTO card_pullbacks (id, tenant_id, driver_id, card_id, proposal_id, advance_id, reason,
                                   requested_cents, balance_cents, pull_cents, shortfall_cents, status,
                                   created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
               CAST($5 AS uuid), $6, $7, $8, $9, $10, 'issuing', CAST($11 AS timestamptz), CAST($11 AS timestamptz))
       ON CONFLICT (tenant_id, proposal_id) DO NOTHING`,
      [
        newId(),
        a.driverId,
        a.cardId,
        p.id,
        a.advanceId,
        a.reason,
        a.requestedCents,
        a.balanceCents,
        a.pullCents,
        a.shortfallCents,
        nowIso,
      ],
    );
    pull = await readPull(q, "proposal_id", p.id);
    if (!pull) throw new DbError("unknown");
  }
  if (
    pull.driverId !== a.driverId ||
    pull.cardId !== a.cardId ||
    pull.advanceId !== a.advanceId ||
    pull.reason !== a.reason ||
    pull.requestedCents !== a.requestedCents ||
    pull.balanceCents !== a.balanceCents ||
    pull.pullCents !== a.pullCents ||
    pull.shortfallCents !== a.shortfallCents
  ) {
    throw new Stop("not_executable");
  }
  if (status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  const rows = await pullRows(q, pull.id);
  const latest = rows.at(-1) ?? null;
  if (pull.status === "pulled") return { kind: "done", moneyActionId: latest?.id ?? null };
  // Pulled, with a record that could not be finished: a person settles it, and nothing is sent again.
  if (pull.status === "unknown") throw new Stop("pull_unknown");
  if (pull.status === "failed" || latest?.state === "failed") {
    if (latest) await onPullFailed(q, latest, nowIso);
    else await failProposal(q, p.id, "pull_failed", nowIso);
    if (latest?.failureCategory === "amount_mismatch") return { kind: "failed", category: "pull_unknown" };
    return { kind: "failed", category: "pull_failed" };
  }
  return { kind: "issue", pull, attempt: latest ? latest.attempt : 1, createdOn };
}

// After a refusal before any ledger row was reserved (the switch went off, the provider was not
// ready, the card did not read): the pull ends failed and so does its proposal, so nothing is left
// issuing with no row. Only while the pull has no ledger row: a row reserved by another approval in
// the meantime keeps the pull for Check pending.
async function abandonUnsent(db: TenantDb, session: Session, pull: PullRow, category: string, nowIso: string): Promise<void> {
  try {
    await db.withTenant(session.tenantId, async (q) => {
      const now = await readPull(q, "id", pull.id, true);
      if (!now || now.status !== "issuing") return;
      if ((await pullRows(q, pull.id)).length > 0) return;
      await q.execute(
        `UPDATE card_pullbacks SET status = 'failed', updated_at = now()
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'
            AND money_action_id IS NULL`,
        [pull.id],
      );
      await failProposal(q, pull.proposalId, `not_sent: ${category}`, nowIso);
    });
  } catch (err) {
    console.error("card pull-back could not be closed:", err instanceof Error ? err.name : "unknown");
  }
}

const GATE_OF_MONEY: Readonly<Record<string, string>> = { disabled: "pullback_off" };

type Issued =
  | { ok: true; state: "done" | "pending"; actionId: string }
  | { ok: false; category: string; retryable: boolean };

async function issue(
  db: TenantDb,
  session: Session,
  pull: PullRow,
  attempt: number,
  createdOn: LocalDate,
  proposal: ProposalRow,
  deps: PullbackDeps,
): Promise<Issued> {
  const nowIso = nowOf(deps).toISOString();
  // The pull gate once more, right before the money executor, and the card read fresh. A refusal
  // here is a definite no with nothing reserved.
  const refusal = pullGate(createdOn);
  if (refusal) {
    await abandonUnsent(db, session, pull, refusal, nowIso);
    return no(refusal === "pullback_before_start" ? "not_executable" : refusal);
  }
  let destination: FuelCardDestination | null;
  try {
    // The first send (no ledger row yet) only to a card still active: a card closed after the pull
    // row was written takes the card_closed path below. With a row, the card is read whatever its
    // status, so the row can be replayed or read back.
    destination = await db.withTenant(session.tenantId, async (q) =>
      readPullDestination(q, pull, { activeOnly: (await pullRows(q, pull.id)).length === 0 }),
    );
  } catch (err) {
    console.error("card pull-back card could not be read:", err instanceof Error ? err.name : "unknown");
    return no("pull_unavailable", true);
  }
  if (!destination) {
    await abandonUnsent(db, session, pull, "card_closed", nowIso);
    return no("card_closed");
  }
  const puller = deps.puller ?? cardPuller();
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "card_pullback",
        subjectId: pull.id,
        counterpartyId: pull.driverId,
        amountCents: pull.pullCents,
        attempt,
        // A chat proposal is the agent's; one with no conversation is a person's.
        proposedBy: proposal.conversationId === null ? "person" : "agent",
        proposalId: pull.proposalId,
        traceId: isCanonicalUuid(proposal.traceId) ? proposal.traceId : null,
        subjectStatuses: ["issuing"],
      },
      pullHooks(puller, destination, createdOn, nowIso),
      deps.money,
    );
    if (r.action.state === "failed") {
      // Another amount confirmed: money moved and the pull waits for a person, never "failed".
      if (r.action.failureCategory === "amount_mismatch") return no("pull_unknown");
      return no(r.action.failureCategory === "disabled" ? "pullback_off" : "pull_failed");
    }
    if (r.action.state === "confirmed") {
      // Done only once the record moved too; a pull marked unknown waits for a person.
      const after = await db.withTenant(session.tenantId, (q) => readPull(q, "id", pull.id)).catch(() => null);
      return { ok: true, state: after?.status === "pulled" ? "done" : "pending", actionId: r.action.id };
    }
    return { ok: true, state: "pending", actionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) {
      // Thrown before a row was reserved (a switch off, the provider not ready, a bad draft):
      // nothing went out. "unknown" is the one exception: the call happened and even the read of
      // its row failed, so it stays pending for Check pending.
      if (err.category === "unknown") return no("pull_pending");
      await abandonUnsent(db, session, pull, err.category, nowIso);
      return no(GATE_OF_MONEY[err.category] ?? "pull_unavailable");
    }
    if (err instanceof ForbiddenError) throw err;
    console.error("card pull-back did not finish:", err instanceof Error ? err.name : "unknown");
    // Not always before a call: money may have moved. Unknown, never a retry.
    return no("pull_pending");
  }
}

// The live indexes (0080): breaking one means another pull for this driver, or for this advance,
// is being sent, was sent, or is not known yet. Matched on the whole constraint name, never a part
// of it. Any other unique violation, or one with no name, stays pull_ref_collision. Either way the
// transaction rolled back, so nothing was written.
export function uniqueViolationCategory(constraint: string | undefined): "pull_exists" | "pull_ref_collision" {
  return constraint === "card_pullbacks_one_live_per_driver" || constraint === "card_pullbacks_one_per_advance"
    ? "pull_exists"
    : "pull_ref_collision";
}

export const executeCardPullback = async (
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: PullbackDeps,
): Promise<ProposalResult> => {
  if (!pullbackOn()) return no("pullback_off");
  if (proposal.kind !== "card_pullback") return no("not_executable");
  if (machineLogin(session)) return no("kind_never_alone");
  const a = pullArgsOf(proposal);
  if (!a) return no("not_executable");
  const now = nowOf(deps);
  const newId = deps.newId ?? randomUUID;
  let prepared: Prepared;
  try {
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, session, proposal, a, now, newId));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    // Two approved proposals for one driver: B's insert breaks the live index, prepare rolls back,
    // and B's proposal stays 'approved' with no pull row. That is safe: a later resume plans again
    // and fails it stale once A pulled, or sends it once if A failed.
    if (err instanceof DbError && err.sqlState === "23505") return no(uniqueViolationCategory(err.constraint));
    throw err;
  }
  if (prepared.kind === "refused" || prepared.kind === "failed") return no(prepared.category);
  if (prepared.kind === "done") {
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: prepared.moneyActionId };
  }
  const issued = await issue(db, session, prepared.pull, prepared.attempt, prepared.createdOn, proposal, deps);
  if (!issued.ok) return issued;
  return {
    ok: true,
    proposalId: proposal.id,
    status: issued.state === "done" ? "done" : "executing",
    moneyActionId: issued.actionId,
  };
};

export const pullbackExecutor: Executor = Object.assign(
  (...args: Parameters<Executor>) => executeCardPullback(...args),
  { precheck: precheckCardPullback },
);

// ---- Check pending ----

// The reconcile pass reads back a row still sent only once it is this old (an unknown row at
// once), so a call still in flight is not read back as if it had been lost.
const CHECK_AFTER_SECONDS = 60;

export type CheckResult =
  | { ok: true; summary: ReconcileSummary; tooNew: number; stillWaiting: number }
  | { ok: false; category: string; retryable: boolean };

// Check pending for one pull: the reconcile pass over this pull's own open ledger rows, each read
// back through the card provider by its request id. Never pulls anything new; a pull found made
// gets the same finishPull the approval would have run (once: the pull row is locked and a pulled
// one is left as it is), and one found not made ends the pull failed. A person asked, so the
// read-back runs even past the automatic check limit; it stays read-only toward the provider.
export async function checkPendingPull(session: Session, pullId: string, deps: PullbackDeps = {}): Promise<CheckResult> {
  if (!pullbackOn()) return no("pullback_off");
  const db = deps.db ?? getDb();
  const nowIso = nowOf(deps).toISOString();
  const found = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const pull = await readPull(q, "id", pullId);
    return pull ? { pull, destination: await readPullDestination(q, pull) } : null;
  });
  if (!found) return no("not_found");
  if (!found.destination) return no("card_closed");
  const puller = deps.puller ?? cardPuller();
  const summary = await reconcileMoneyActions(
    db,
    session,
    {
      hooks: { card_pullback: pullReconcileHooks(puller, found.destination, nowIso) },
      limit: 5,
      olderThanSeconds: CHECK_AFTER_SECONDS,
      subject: { table: "card_pullbacks", id: found.pull.id },
      ignoreCheckLimit: true,
    },
    deps.money,
  );
  let tooNew = 0;
  let stillWaiting = 0;
  if (summary.checked === 0) {
    const rows = await db.withTenant(session.tenantId, (q) => pullRows(q, found.pull.id));
    for (const r of rows) {
      if (r.state === "sent" && r.sentSecondsAgo !== null && r.sentSecondsAgo <= CHECK_AFTER_SECONDS) tooNew += 1;
      else if (r.state === "sent" || r.state === "unknown") stillWaiting += 1;
    }
  }
  return { ok: true, summary, tooNew, stillWaiting };
}
