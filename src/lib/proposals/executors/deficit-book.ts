import type { Session } from "../../auth/claims";
import { requireStaff } from "../../auth/role";
import { CANCELLED_TRIP_REASON } from "../../advances/takeback-words";
import { isAutopilotSub } from "../../autopilot/session";
import type { Queryable, TenantDb } from "../../db";
import { DEFICIT_SQL, LIVE_PULL_SQL } from "../../deficits/cancelled-trip";
import { cancelledTripEnabled } from "../../deficits/switches";
import { dollars } from "../../money/format";
import { isServiceSub } from "../../sweep/service-session";
import { assertMembership, ForbiddenError } from "../../tenant/context";
import { isUuid } from "../../uuid";
import type { ApproveOptions, ExecuteDeps, Executor, Precheck, ProposalRefused, ProposalResult, ProposalRow } from "../execute";

// The deficit_book executor (CANCELLED-TRIP, S6c). A deficit card says "load BR-1042 was cancelled
// after Dana got a $400.00 advance on it". A named staff member approves it, in one transaction
// under the tenant's row-level security:
//   a. re-read the proposal FOR UPDATE: approved or executing, kind deficit_book, args that read
//      back whole and say what the row says (the advance is its subject, the same whole cents);
//   b. lock the advance FOR UPDATE and re-check the facts, because time passed: still paid, not
//      taken back, the card's driver and load, what is owed equals the card's cents whole, the
//      load still cancelled, no cancelled-trip deficit on it yet, no card pull-back taking it back
//      right now, and no approved paystub waiting to book a recovery of it. Any failure marks the
//      proposal failed with the note "stale" and writes nothing;
//   c. approved -> executing;
//   d. close the advance line: taken_back_cents grows by the owed cents (so outstanding is zero),
//      stamped with the approver and the reason cancelled_trip, under a guard that repeats the
//      facts (one row or throw, which rolls the whole transaction back);
//   e. one driver_deficits row (source cancelled_trip, the advance as its source), named by the
//      approver, ON CONFLICT on the proposal DO NOTHING and read back whole;
//   f. executing -> done.
// The driver owes the cents once: the advance stops counting in the same transaction the deficit
// starts counting. Money never moves here: no adapter is called and nothing is sent. Never the
// autopilot's and never the sweep's login (the gate refuses them too; this is its own wall).
//
// The switch: cancelledTrip.enabled off refuses as not_executable before anything is read or
// written, here and in the precheck, even when a caller reaches this executor directly.

type Args = {
  driverId: string;
  advanceId: string;
  loadId: string;
  amountCents: number;
};

type Locked = {
  id: string;
  kind: string;
  status: string;
  subject_table: string;
  subject_id: string;
  amount_cents: number | string;
  args: string;
};

type AdvanceFacts = {
  driver_id: string;
  load_id: string | null;
  status: string;
  owed: string;
  taken_back_at: string | null;
};

const refused = (category: string): ProposalRefused => ({ ok: false, category, retryable: false });

const uuidOf = (v: unknown): string | null => (typeof v === "string" && isUuid(v) ? v.toLowerCase() : null);

function argsFrom(v: unknown): Args | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const driverId = uuidOf(a.driverId);
  const advanceId = uuidOf(a.advanceId);
  const loadId = uuidOf(a.loadId);
  if (driverId === null || advanceId === null || loadId === null || uuidOf(a.loadEventId) === null) return null;
  if (a.sourceKind !== "cancelled_trip") return null;
  const cents = a.amountCents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) return null;
  return { driverId, advanceId, loadId, amountCents: cents };
}

function argsOf(text: string): Args | null {
  try {
    return argsFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

// The args say what the proposal row says: the advance is its subject, and the same cents.
function argsMatchRow(a: Args | null, subjectTable: string, subjectId: string, amountCents: number): a is Args {
  return a !== null && subjectTable === "advances" && a.advanceId === subjectId.toLowerCase() && a.amountCents === amountCents;
}

// A named person, never a login that acts by itself.
const machineLogin = (session: Session): boolean => isAutopilotSub(session.sub) || isServiceSub(session.sub);

const ADVANCE_SQL = `SELECT CAST(driver_id AS text) AS driver_id, CAST(load_id AS text) AS load_id, status,
       CAST(amount_cents + fee_cents - recovered_cents - taken_back_cents AS text) AS owed,
       CAST(taken_back_at AS text) AS taken_back_at
  FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

const LOAD_SQL = `SELECT load_number, status FROM loads
  WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

// An approved paystub, not booked yet, with a recovery line on this advance: booking it after the
// advance is closed would over-recover it, so the card waits for that stub instead.
const APPROVED_RECOVERY_SQL = `SELECT 1 AS one FROM settlement_lines l
  JOIN settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
 WHERE l.tenant_id = current_tenant_id() AND s.status = 'approved' AND l.kind = 'advance_recovery'
   AND l.sources @> CAST($1 AS jsonb) LIMIT 1`;

// The load's number when every fact the card was made on still holds, else null. lock takes the
// advance FOR UPDATE (the executor). The load is read without a lock: cancelled is a last status,
// and the desk's drafting holds the load's lock while it waits on this card's row.
async function factsHold(q: Queryable, a: Args, lock: boolean): Promise<string | null> {
  const [adv] = await q.query<AdvanceFacts>(`${ADVANCE_SQL}${lock ? " FOR UPDATE" : ""}`, [a.advanceId]);
  if (!adv) return null;
  if (adv.status !== "paid" || adv.taken_back_at !== null) return null;
  if (adv.driver_id !== a.driverId || adv.load_id !== a.loadId) return null;
  if (Number(adv.owed) !== a.amountCents) return null;
  const [load] = await q.query<{ load_number: string; status: string }>(LOAD_SQL, [a.loadId]);
  if (!load || load.status !== "cancelled") return null;
  if ((await q.query(DEFICIT_SQL, [a.advanceId])).length > 0) return null;
  if ((await q.query(LIVE_PULL_SQL, [a.advanceId])).length > 0) return null;
  const cites = JSON.stringify([{ table: "advances", id: a.advanceId }]);
  if ((await q.query(APPROVED_RECOVERY_SQL, [cites])).length > 0) return null;
  return load.load_number;
}

// The caller's one membership row in the tenant, or null.
async function memberOf(q: Queryable, session: Session): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  return rows.length === 1 ? rows[0].id : null;
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

async function fail(q: Queryable, id: string, note: string, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $3, updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('approved', 'executing')`,
    [id, nowIso, note],
  );
}

// The deficit's note, code only: the load's number and the advance's owed cents.
export function cancelledTripNote(loadNumber: string, amountCents: number): string {
  return `Load ${loadNumber} cancelled after a ${dollars(amountCents)} advance on it.`;
}

// The advance line closed: what is owed moves to taken back, under the same facts, one row.
async function closeAdvance(q: Queryable, a: Args, namedBy: string, nowIso: string): Promise<void> {
  const n = await q.execute(
    `UPDATE advances
        SET taken_back_cents = taken_back_cents + $2, taken_back_at = CAST($3 AS timestamptz),
            taken_back_by_membership_id = CAST($4 AS uuid), takeback_reason = $5
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($6 AS uuid)
        AND status = 'paid' AND taken_back_at IS NULL
        AND amount_cents + fee_cents - recovered_cents - taken_back_cents = $2`,
    [a.advanceId, a.amountCents, nowIso, namedBy, CANCELLED_TRIP_REASON, a.driverId],
  );
  if (n !== 1) throw new Error("the cancelled trip's advance did not close under its lock");
}

// One deficit for the proposal: written once and read back whole. True when the one row there
// carries the advance's driver, its source and the whole cents.
async function bookDeficit(
  q: Queryable,
  a: Args,
  proposalId: string,
  loadNumber: string,
  namedBy: string,
  nowIso: string,
): Promise<boolean> {
  await q.execute(
    `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id,
                                  named_by, proposal_id, created_at)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, 'cancelled_trip', CAST($4 AS uuid),
             CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS timestamptz))
     ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
    [a.driverId, a.amountCents, cancelledTripNote(loadNumber, a.amountCents), a.advanceId, namedBy, proposalId, nowIso],
  );
  const rows = await q.query<{ driver_id: string; amount_cents: string; source_kind: string; source_id: string }>(
    `SELECT CAST(driver_id AS text) AS driver_id, CAST(amount_cents AS text) AS amount_cents, source_kind,
            CAST(source_id AS text) AS source_id
       FROM driver_deficits
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
    [proposalId],
  );
  return (
    rows.length === 1 &&
    rows[0].driver_id === a.driverId &&
    Number(rows[0].amount_cents) === a.amountCents &&
    rows[0].source_kind === "cancelled_trip" &&
    rows[0].source_id === a.advanceId
  );
}

async function apply(q: Queryable, session: Session, proposalId: string, now: Date): Promise<ProposalResult> {
  await assertMembership(q, session);
  if ((await staffRole(q, session)) === null) return refused("role");
  const rows = await q.query<Locked>(
    `SELECT CAST(id AS text) AS id, kind, status, subject_table, CAST(subject_id AS text) AS subject_id,
            amount_cents, CAST(args AS text) AS args
       FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId],
  );
  if (rows.length !== 1) return refused("not_found");
  const p = rows[0];
  if (p.kind !== "deficit_book") return refused("not_executable");
  if (p.status === "done") return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  if (p.status !== "approved" && p.status !== "executing") return refused("already_decided");
  const nowIso = now.toISOString();

  const a = argsOf(p.args);
  if (!argsMatchRow(a, p.subject_table, p.subject_id, Number(p.amount_cents))) {
    await fail(q, p.id, "not_executable", nowIso);
    return refused("not_executable");
  }
  const loadNumber = await factsHold(q, a, true);
  if (loadNumber === null) {
    await fail(q, p.id, "stale", nowIso);
    console.info(`proposal ${p.id} deficit_book refused=stale`);
    return refused("stale");
  }
  const namedBy = await memberOf(q, session);
  if (namedBy === null) {
    await fail(q, p.id, "role", nowIso);
    return refused("role");
  }
  if (p.status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  await closeAdvance(q, a, namedBy, nowIso);
  if (!(await bookDeficit(q, a, p.id, loadNumber, namedBy, nowIso))) {
    // Another row holds this proposal's deficit with other values: never adopted, never doubled.
    throw new Error("the cancelled trip's deficit did not read back");
  }
  const n = await q.execute(
    `UPDATE proposals SET status = 'done', decision_note = 'booked', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [p.id, nowIso],
  );
  if (n !== 1) throw new Error("the deficit card did not move to done");
  console.info(`proposal ${p.id} deficit_book done`);
  return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
}

// The gate's early refusal (see Precheck in execute.ts): inside the gate's transaction, with the
// proposal still proposed and locked. Reads only.
export const precheckDeficitBook: Precheck = async (q, proposal: ProposalRow, _now, ctx) => {
  if (!cancelledTripEnabled()) return refused("not_executable");
  if (proposal.kind !== "deficit_book") return refused("not_executable");
  if (!ctx) return refused("not_executable");
  if (machineLogin(ctx.session)) return refused("kind_never_alone");
  if ((await staffRole(q, ctx.session)) === null) return refused("role");
  const a = argsFrom(proposal.args);
  if (!argsMatchRow(a, proposal.subjectTable, proposal.subjectId, proposal.amountCents)) return refused("not_executable");
  if ((await factsHold(q, a, false)) === null) {
    console.info(`proposal ${proposal.id} deficit_book precheck=stale`);
    return refused("stale");
  }
  if ((await memberOf(q, ctx.session)) === null) return refused("role");
  return null;
};

async function runDeficitBook(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: ExecuteDeps,
): Promise<ProposalResult> {
  if (!cancelledTripEnabled()) return refused("not_executable");
  if (proposal.kind !== "deficit_book") return refused("not_executable");
  if (machineLogin(session)) return refused("kind_never_alone");
  const now = (deps.clock ?? (() => new Date()))();
  return db.withTenant(session.tenantId, (q) => apply(q, session, proposal.id, now));
}

export const deficitBookExecutor: Executor = Object.assign(runDeficitBook, { precheck: precheckDeficitBook });
