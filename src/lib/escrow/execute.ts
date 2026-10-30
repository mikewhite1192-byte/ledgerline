import { randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import { DbError, type Queryable, type TenantDb } from "../db";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { MoneyError, type MoneyAction } from "../money/types";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../proposals/execute";
import { ForbiddenError } from "../tenant/context";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import {
  liveReleaseOf,
  readDriverEscrow,
  readDriverReleases,
  readRelease,
  releaseFactRefusal,
  type ReleaseFactRefusal,
  type ReleaseRow,
} from "./read";
import { escrowReleaseGate, escrowReleaseOn } from "./switches";

// A person approves an escrow_release proposal, and only then is the driver's balance sent back
// (design 3). The proposal gate (src/lib/proposals/execute.ts) has checked the person, the role,
// the auditor and the second confirm, and asked precheckEscrowRelease while the proposal still
// waited. Then, in one tenant transaction with the proposal locked (and, for a new release, the
// driver), this executor asks the release gate again, checks the facts as of now (the driver
// still terminated, no other live release, the balance still exactly the proposal's amount; a
// proposal whose facts no longer hold ends failed, nothing sent), writes the escrow_releases row
// as 'issuing' (one per proposal: escrow_releases_one_per_proposal; one live per driver:
// escrow_releases_one_live_per_driver) and moves the proposal to executing. The money executor
// then reserves the ledger row (idempotency key escrow_release:<release id>:1, request id = the
// row id without dashes), the reserve asking the release gate once more, makes the one bank
// payout through the payment adapter (Stripe test mode, the one test connected account, demo
// carriers only) and settles it:
//   confirmed  finishRelease, in the settle transaction: the driver's balance goes to zero by an
//              update guarded on the balance still being the amount, the release 'released' with
//              its release time, the proposal done. A balance that moved meanwhile is never
//              written below zero: the release is marked 'unknown' for a person, and a log line
//              names it by id
//   failed     the release 'failed' and the proposal failed; the balance stays
//   unknown    the release stays 'issuing' until Check pending reads the row back by its request
//              id and settles it (the same finishRelease), never a second payout
// The same proposal approved twice, or run again, finds its release by proposal id and replays
// the same ledger row by its key, so one release makes one transfer. A retry after a failure is a
// new proposal, a new release row and a new ledger row; the failed one stays as the record.

export type EscrowDeps = ExecuteDeps & {
  money?: Partial<MoneyDeps>;
  newId?: () => string;
};

const NOTE_MAX = 240;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`escrow release: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

// Now, from the injected clock. The one place this file reads the wall clock is the default when
// no clock is injected; every stamp below is written from the value this returns.
export const nowOf = (deps: EscrowDeps): Date => (deps.clock ?? (() => new Date()))();

// ---- The proposal's args ----

export type ReleaseArgs = { driverId: string; amountCents: number; balanceAsOf: LocalDate };

// The proposal's args read whole: the driver the proposal's subject, the amount the proposal's
// own and positive, the balance date a real date. Anything else is not executable.
export function releaseArgsOf(p: ProposalRow): ReleaseArgs | null {
  const a = p.args;
  if (
    p.kind !== "escrow_release" ||
    p.subjectTable !== "drivers" ||
    !isCanonicalUuid(p.subjectId) ||
    a.driverId !== p.subjectId ||
    !Number.isSafeInteger(p.amountCents) ||
    p.amountCents <= 0 ||
    a.amountCents !== p.amountCents ||
    typeof a.balanceAsOf !== "string" ||
    !isLocalDate(a.balanceAsOf)
  ) {
    return null;
  }
  return { driverId: p.subjectId, amountCents: p.amountCents, balanceAsOf: a.balanceAsOf };
}

// A fact refusal in the approval's words: a balance that is no longer the proposal's amount (or
// is gone) is stale, whatever it moved to.
export function factCategory(fact: ReleaseFactRefusal): string {
  if (fact === "driver_not_found") return "not_found";
  if (fact === "amount_mismatch" || fact === "zero_balance") return "stale";
  return fact;
}

// ---- Shared reads and writes ----

async function releaseRows(q: Queryable, releaseId: string): Promise<MoneyAction[]> {
  return (await readBySubject(q, "escrow_releases", releaseId)).filter((a) => a.kind === "escrow_release");
}

async function todayIn(q: Queryable, nowIso: string): Promise<LocalDate> {
  return localDateOf(nowIso, await readTenantZone(q));
}

// An escrow_release proposal that ends without a transfer, with a note code the record says in
// words. Only from approved or executing, the two states the proposal guard lets move to failed.
function failProposal(q: Queryable, proposalId: string, note: string, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'escrow_release'
        AND status IN ('approved', 'executing')`,
    [proposalId, note.slice(0, NOTE_MAX), nowIso],
  );
}

// ---- The ledger hooks ----

// In the reserve transaction: the release gate once more (a switch turned off since the approval
// rolls the reservation back, nothing sent), then the release names its ledger row and the
// proposal records its first. The release must still be issuing with no row; a throw rolls the
// reservation back.
async function onReleaseReserved(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  if (escrowReleaseGate(action.amountCents, await todayIn(q, nowIso)) !== null) throw new MoneyError("disabled");
  const changed = await q.execute(
    `UPDATE escrow_releases SET money_action_id = CAST($2 AS uuid), updated_at = now()
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

// The post-confirm step, in the settle transaction (the executor's or the reconcile pass's).
// Idempotent: the release row is locked first, a released one is left as it is (only its
// proposal is closed), and an unknown one stays for a person. The balance update is guarded on
// the balance still being exactly the amount, so it ends at zero or does not happen: it never
// writes a negative balance or takes a deposit made since. nowIso is the caller's clock, written
// as the release time (as created_at is written), so a test clock fixes the statement's date.
export async function finishRelease(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  if (action.kind !== "escrow_release" || action.state !== "confirmed") throw new MoneyError("validation");
  const release = await readRelease(q, "id", action.subjectId, true);
  if (!release || release.driverId !== action.counterpartyId || release.amountCents !== action.amountCents) {
    throw new MoneyError("validation");
  }
  if (release.status === "released") {
    await closeProposal(q, action.proposalId);
    return;
  }
  if (release.status === "unknown") return;
  // A failed release with a confirmed payout is not something this step can settle: the throw
  // keeps the ledger row open for a person.
  if (release.status !== "issuing") throw new MoneyError("validation");
  const releasedAt = nowIso;
  if (!Number.isFinite(Date.parse(releasedAt))) throw new MoneyError("validation");
  const moved = await q.execute(
    `UPDATE drivers SET escrow_balance_cents = escrow_balance_cents - $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND escrow_balance_cents = $2`,
    [release.driverId, release.amountCents],
  );
  if (moved !== 1) {
    // The money went out but the balance is no longer the amount: written as unknown, with the
    // proposal left executing, so a person settles the difference. Ids only in the log.
    await q.execute(
      `UPDATE escrow_releases SET status = 'unknown', updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
      [release.id],
    );
    console.error(`escrow release ${release.id}: the balance moved before the payout settled; marked unknown`);
    return;
  }
  const changed = await q.execute(
    `UPDATE escrow_releases
        SET status = 'released', released_at = CAST($2 AS timestamptz),
            money_action_id = COALESCE(money_action_id, CAST($3 AS uuid)), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
    [release.id, releasedAt, action.id],
  );
  if (changed !== 1) throw new MoneyError("validation");
  await closeProposal(q, action.proposalId);
}

async function closeProposal(q: Queryable, proposalId: string | null): Promise<void> {
  if (!proposalId) return;
  await q.execute(
    `UPDATE proposals SET status = 'done', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [proposalId],
  );
}

// A definite failure: nothing was paid. The release ends failed and so does its proposal, stamped
// with the caller's clock. The balance is never touched.
async function onReleaseFailed(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE escrow_releases SET status = 'failed', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
    [action.subjectId],
  );
  if (action.proposalId) {
    await failProposal(q, action.proposalId, `release_failed: ${action.failureCategory ?? "unknown"}`, nowIso);
  }
}

// A payout on the bank rail: the payment adapter sends it and reads it back, so the hooks are the
// caller's writes only (no send, no ready check, and no destination: one test connected account).
function releaseHooks(nowIso: string): MoneyHooks {
  return {
    onReserved: (q, action) => onReleaseReserved(q, action, nowIso),
    onConfirmed: (q, action) => finishRelease(q, action, nowIso),
    onFailed: (q, action) => onReleaseFailed(q, action, nowIso),
  };
}

export function releaseReconcileHooks(nowIso: string) {
  return {
    onConfirmed: (q: Queryable, action: MoneyAction) => finishRelease(q, action, nowIso),
    onFailed: (q: Queryable, action: MoneyAction) => onReleaseFailed(q, action, nowIso),
  };
}

// ---- Approval ----

// The gate's early refusal (Precheck in src/lib/proposals/execute.ts), under the gate's proposal
// lock before the proposal becomes approved: a refusal leaves it waiting, with nothing written.
// Reads only, against live data: every refusal the propose tool has, with a balance that moved
// since the card was made read as stale. The executor asks all of it again after the approval.
export async function precheckEscrowRelease(q: Queryable, p: ProposalRow, now: Date): Promise<ProposalRefused | null> {
  if (!escrowReleaseOn()) return no("escrow_off");
  const a = releaseArgsOf(p);
  if (!a) return no("not_executable");
  const today = await todayIn(q, now.toISOString());
  const refusal = escrowReleaseGate(a.amountCents, today);
  if (refusal) return no(refusal);
  if (await readRelease(q, "proposal_id", p.id)) return no("release_exists");
  const driver = await readDriverEscrow(q, a.driverId);
  const live = driver ? liveReleaseOf(await readDriverReleases(q, a.driverId)) : null;
  const fact = releaseFactRefusal(driver, live, a.amountCents, today);
  return fact ? no(factCategory(fact)) : null;
}

type Prepared =
  | { kind: "issue"; release: ReleaseRow; attempt: number }
  | { kind: "done"; moneyActionId: string | null }
  | { kind: "refused"; category: string }
  | { kind: "failed"; category: string };

async function prepare(q: Queryable, p: ProposalRow, a: ReleaseArgs, now: Date, newId: () => string): Promise<Prepared> {
  const locked = await q.query<{ status: string }>(
    `SELECT status FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'escrow_release'
      FOR UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const status = locked[0].status;
  if (status === "proposed") throw new Stop("not_executable");
  if (status !== "approved" && status !== "executing") throw new Stop("already_decided");

  const nowIso = now.toISOString();
  const today = await todayIn(q, nowIso);
  const refusal = escrowReleaseGate(a.amountCents, today);
  if (refusal) throw new Stop(refusal);

  // The release row is read, never locked, here. The reserve and settle transactions lock the
  // release first and then the driver or the proposal; this one already holds the proposal, so
  // waiting on the release would close a cycle with a reserve or settle in flight. The proposal
  // lock already serializes approvals, and the reserve locks the release and asks its status again.
  let release = await readRelease(q, "proposal_id", p.id);
  if (!release) {
    // A new release: the driver's row lock holds the balance and the last active day until this
    // commits. A resume (the release already written) takes no driver lock, for the same cycle.
    const driver = await readDriverEscrow(q, a.driverId, true);
    const live = driver ? liveReleaseOf(await readDriverReleases(q, a.driverId)) : null;
    const fact = releaseFactRefusal(driver, live, a.amountCents, today);
    if (fact || !driver) {
      // The facts changed since the proposal: no release. Written and returned (the commit keeps
      // it), so the card and the record say why.
      const category = factCategory(fact ?? "driver_not_found");
      await failProposal(q, p.id, `refused: ${category}`, nowIso);
      return { kind: "refused", category };
    }
    await q.execute(
      `INSERT INTO escrow_releases (id, tenant_id, driver_id, proposal_id, opening_balance_cents, amount_cents,
                                    status, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, 'issuing',
               CAST($6 AS timestamptz), CAST($6 AS timestamptz))
       ON CONFLICT (tenant_id, proposal_id) DO NOTHING`,
      [newId(), a.driverId, p.id, driver.balanceCents, a.amountCents, nowIso],
    );
    release = await readRelease(q, "proposal_id", p.id);
    if (!release) throw new DbError("unknown");
  }
  if (release.driverId !== a.driverId || release.amountCents !== a.amountCents) throw new Stop("not_executable");
  if (status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  const rows = await releaseRows(q, release.id);
  const latest = rows.at(-1) ?? null;
  if (release.status === "released") return { kind: "done", moneyActionId: latest?.id ?? null };
  // Paid, with a balance that had moved: a person settles it, and nothing is sent again.
  if (release.status === "unknown") throw new Stop("release_unknown");
  if (release.status === "failed" || latest?.state === "failed") {
    if (latest) await onReleaseFailed(q, latest, nowIso);
    else await failProposal(q, p.id, "release_failed", nowIso);
    return { kind: "failed", category: "release_failed" };
  }
  return { kind: "issue", release, attempt: latest ? latest.attempt : 1 };
}

// After a refusal before any ledger row was reserved (the switch went off, the adapter was not
// ready): the release ends failed and so does its proposal, so nothing is left issuing with no
// row. Only while the release has no ledger row: a row reserved by another approval in the
// meantime keeps the release for the reconcile pass.
async function abandonUnsent(
  db: TenantDb,
  session: Session,
  release: ReleaseRow,
  category: string,
  nowIso: string,
): Promise<void> {
  try {
    await db.withTenant(session.tenantId, async (q) => {
      const now = await readRelease(q, "id", release.id, true);
      if (!now || now.status !== "issuing") return;
      if ((await releaseRows(q, release.id)).length > 0) return;
      await q.execute(
        `UPDATE escrow_releases SET status = 'failed', updated_at = now()
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'
            AND money_action_id IS NULL`,
        [release.id],
      );
      await failProposal(q, release.proposalId, `not_sent: ${category}`, nowIso);
    });
  } catch (err) {
    console.error("escrow release could not be closed:", err instanceof Error ? err.name : "unknown");
  }
}

const GATE_OF_MONEY: Readonly<Record<string, string>> = { disabled: "escrow_off" };

type Issued =
  | { ok: true; state: "done" | "pending"; actionId: string }
  | { ok: false; category: string; retryable: boolean };

async function issue(
  db: TenantDb,
  session: Session,
  release: ReleaseRow,
  attempt: number,
  proposal: ProposalRow,
  deps: EscrowDeps,
): Promise<Issued> {
  const nowIso = nowOf(deps).toISOString();
  // The release gate once more, right before the money executor: the executor itself re-checks
  // only payoutsEnabled, the demo carriers and the adapter. A refusal here is a definite no with
  // nothing reserved.
  let refusal: string | null;
  try {
    refusal = escrowReleaseGate(
      release.amountCents,
      await db.withTenant(session.tenantId, (q) => todayIn(q, nowIso)),
    );
  } catch (err) {
    console.error("escrow release gate could not be read:", err instanceof Error ? err.name : "unknown");
    return no("release_unavailable", true);
  }
  if (refusal) {
    await abandonUnsent(db, session, release, refusal, nowIso);
    return no(refusal);
  }
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "escrow_release",
        subjectId: release.id,
        counterpartyId: release.driverId,
        amountCents: release.amountCents,
        attempt,
        // A chat proposal is the agent's; one with no conversation is a person's.
        proposedBy: proposal.conversationId === null ? "person" : "agent",
        proposalId: release.proposalId,
        traceId: isCanonicalUuid(proposal.traceId) ? proposal.traceId : null,
        subjectStatuses: ["issuing"],
      },
      releaseHooks(nowIso),
      deps.money,
    );
    if (r.action.state === "failed") {
      return no(r.action.failureCategory === "disabled" ? "escrow_off" : "release_failed");
    }
    if (r.action.state === "confirmed") {
      // Done only once the balance moved too; a release marked unknown waits for a person.
      const after = await db
        .withTenant(session.tenantId, (q) => readRelease(q, "id", release.id))
        .catch(() => null);
      return { ok: true, state: after?.status === "released" ? "done" : "pending", actionId: r.action.id };
    }
    return { ok: true, state: "pending", actionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) {
      // Thrown before a row was reserved (a switch off, the adapter not ready, a bad draft):
      // nothing went out. "unknown" is the one exception: the send happened and even the read of
      // its row failed, so it stays pending for Check pending.
      if (err.category === "unknown") return no("release_pending");
      await abandonUnsent(db, session, release, err.category, nowIso);
      return no(GATE_OF_MONEY[err.category] ?? "release_unavailable");
    }
    if (err instanceof ForbiddenError) throw err;
    console.error("escrow release did not finish:", err instanceof Error ? err.name : "unknown");
    // Not always before a send: money may have moved. Unknown, never a retry.
    return no("release_pending");
  }
}

// The one-live index (0069): breaking it means another release for this driver is being sent,
// was sent, or is not known yet. Matched on the whole constraint name, never a part of it. Any
// other unique violation, or one with no name, stays release_ref_collision. Either way the
// transaction rolled back, so nothing was written.
export function uniqueViolationCategory(constraint: string | undefined): "release_exists" | "release_ref_collision" {
  return constraint === "escrow_releases_one_live_per_driver" ? "release_exists" : "release_ref_collision";
}

export const executeEscrowRelease: Executor = async (
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: EscrowDeps,
): Promise<ProposalResult> => {
  if (!escrowReleaseOn()) return no("escrow_off");
  const a = releaseArgsOf(proposal);
  if (!a) return no("not_executable");
  const now = nowOf(deps);
  const newId = deps.newId ?? randomUUID;
  let prepared: Prepared;
  try {
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, proposal, a, now, newId));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    if (err instanceof DbError && err.sqlState === "23505") return no(uniqueViolationCategory(err.constraint));
    throw err;
  }
  if (prepared.kind === "refused" || prepared.kind === "failed") return no(prepared.category);
  if (prepared.kind === "done") {
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: prepared.moneyActionId };
  }
  const issued = await issue(db, session, prepared.release, prepared.attempt, proposal, deps);
  if (!issued.ok) return issued;
  return {
    ok: true,
    proposalId: proposal.id,
    status: issued.state === "done" ? "done" : "executing",
    moneyActionId: issued.actionId,
  };
};

export const escrowReleaseExecutor: Executor = Object.assign(
  (...args: Parameters<Executor>) => executeEscrowRelease(...args),
  { precheck: precheckEscrowRelease },
);
