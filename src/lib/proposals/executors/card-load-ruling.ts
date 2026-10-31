import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { requireStaff } from "../../auth/role";
import { isAutopilotSub } from "../../autopilot/session";
import { cardDriver, hasLedgerRow, hasOtherDeficit, loadCents, readLoadRow } from "../../card-loads/facts";
import type { Queryable, TenantDb } from "../../db";
import { dollars } from "../../money/format";
import { isServiceSub } from "../../sweep/service-session";
import { assertMembership, ForbiddenError } from "../../tenant/context";
import { isLocalDate } from "../../time/local-date";
import { isUuid } from "../../uuid";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  Precheck,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../execute";

// The card_load_ruling executor (CARD-LOAD-RULING). A ruling card says "the fuel card ending 4417
// got a $400.00 load with no payment record behind it". A named staff member rules on it, in one
// transaction under the tenant's row-level security:
//   a. re-read the proposal FOR UPDATE: approved or executing (a resume), kind card_load_ruling,
//      args that read back whole and say what the row says (the statement row, its whole cents);
//   b. the ruling from the edits stored with the approval only (approved_edits, the gate writes
//      them): none means the drafted ruling (a deficit for the full load); {ruling: owes_nothing}
//      means none. A request whose edits differ from the stored ones is refused (edits_changed);
//   c. re-check the facts, because time passed: the statement row is the one the card named (its
//      kind, reference and amount), no payment record names it, no other ruling booked a deficit on
//      it, and the card is still that driver's. Any failure marks the proposal failed with the note "stale" and writes nothing;
//   d. approved -> executing;
//   e. on a deficit, one driver_deficits row for the full load amount, named by the member who
//      ruled, ON CONFLICT on the proposal DO NOTHING and read back, so a resume adopts the row a
//      stopped run wrote; on owes_nothing, nothing is booked;
//   f. the card check's open "load not in the ledger" difference on that row resolved;
//   g. executing -> done, with the ruling as the decision note.
// Money never moves here: no adapter is called and nothing is sent. Never the autopilot's and
// never the sweep's login: a named person rules (the gate refuses them too; this is its own wall).
//
// The switch: cardLoadRuling.enabled off refuses as not_executable before anything is read or
// written, here and in the precheck, even when a caller reaches this executor directly.

export const RULINGS = ["owes_nothing", "deficit"] as const;
export type Ruling = (typeof RULINGS)[number];

type Edits = Readonly<Record<string, string>>;

type Args = {
  transactionId: string;
  providerRef: string;
  amountCents: number;
  driverId: string;
  cardLast4: string;
  postedOn: string;
  ruling: Ruling;
};

type Locked = {
  id: string;
  kind: string;
  status: string;
  subject_table: string;
  subject_id: string;
  amount_cents: number | string;
  args: string;
  approved_edits: string | null;
};

const refused = (category: string): ProposalRefused => ({ ok: false, category, retryable: false });

const isRuling = (v: unknown): v is Ruling => typeof v === "string" && (RULINGS as readonly string[]).includes(v);

function argsFrom(v: unknown): Args | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.transactionId !== "string" || !isUuid(a.transactionId)) return null;
  if (typeof a.driverId !== "string" || !isUuid(a.driverId)) return null;
  if (typeof a.providerRef !== "string" || !/^fcs_load_[0-9a-f]{24}$/.test(a.providerRef)) return null;
  const cents = a.amountCents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) return null;
  if (typeof a.cardLast4 !== "string" || !/^[0-9]{4}$/.test(a.cardLast4)) return null;
  if (!isLocalDate(a.postedOn)) return null;
  if (!isRuling(a.ruling)) return null;
  return {
    transactionId: a.transactionId.toLowerCase(),
    providerRef: a.providerRef,
    amountCents: cents,
    driverId: a.driverId.toLowerCase(),
    cardLast4: a.cardLast4,
    postedOn: a.postedOn,
    ruling: a.ruling,
  };
}

function argsOf(text: string): Args | null {
  try {
    return argsFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

// The args say what the proposal row says: the statement row is its subject, and the same cents.
function argsMatchRow(a: Args | null, subjectTable: string, subjectId: string, amountCents: number): a is Args {
  return (
    a !== null &&
    subjectTable === "card_transactions" &&
    a.transactionId === subjectId.toLowerCase() &&
    a.amountCents === amountCents
  );
}

// The ruling a person made. No edits (or an empty map) is the drafted ruling. Edits may hold only
// the key ruling, with a whole value from RULINGS; any other key or value is null (refused). Pure.
export function rulingOf(args: unknown, edits: Edits | null): Ruling | null {
  const drafted = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).ruling : null;
  if (!isRuling(drafted)) return null;
  if (edits === null) return drafted;
  const keys = Object.keys(edits);
  if (keys.length === 0) return drafted;
  if (keys.length !== 1 || keys[0] !== "ruling") return null;
  const value = edits.ruling;
  return isRuling(value) ? value : null;
}

// A ruling other than the drafted one is a second tap: an approval that carries edits always
// needs the confirm, even on a pass (pay_policy_setup's rule).
const editsUnconfirmed = (opts: { confirmed: boolean; edits?: Edits }): boolean =>
  Object.keys(opts.edits ?? {}).length > 0 && !opts.confirmed;

// The edits stored with the approval: a JSON object of string values, or null when there is none
// or it does not read (unknown is never taken as no edits).
function storedEdits(text: string | null): Edits | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  if (!entries.every(([, value]) => typeof value === "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

// The same edits: the same keys, each with the same whole value.
function sameEdits(a: Edits, b: Edits): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

// A named person, never a login that acts by itself.
const machineLogin = (session: Session): boolean => isAutopilotSub(session.sub) || isServiceSub(session.sub);

// True when every fact the card was made on still holds.
async function factsHold(q: Queryable, a: Args, proposalId: string): Promise<boolean> {
  const row = await readLoadRow(q, a.transactionId);
  if (!row || row.kind !== "load" || row.provider_ref !== a.providerRef || loadCents(row) !== a.amountCents) {
    return false;
  }
  if (await hasLedgerRow(q, a.providerRef)) return false;
  if (await hasOtherDeficit(q, a.transactionId, proposalId)) return false;
  return (await cardDriver(q, row.provider, row.card_token)) === a.driverId;
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

async function resolveBreak(q: Queryable, transactionId: string, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE card_recon_breaks
        SET status = 'resolved', resolved_at = CAST($2 AS timestamptz), updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND card_transaction_id = CAST($1 AS uuid)
        AND category = 'load_not_in_ledger' AND status = 'open'`,
    [transactionId, nowIso],
  );
}

// The deficit's note, code only: the amount, the card's last four and the posting day.
export function deficitNote(a: Pick<Args, "amountCents" | "cardLast4" | "postedOn">): string {
  return `Card load ${dollars(a.amountCents)} on card ending ${a.cardLast4}, posted ${a.postedOn}, no payment record.`;
}

// One deficit for the proposal: written once, read back, and adopted on a resume. True when the
// one row there carries the load's driver and whole cents.
async function bookDeficit(
  q: Queryable,
  a: Args,
  proposalId: string,
  namedBy: string,
  nowIso: string,
): Promise<boolean> {
  await q.execute(
    `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id,
                                  named_by, proposal_id, created_at)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, 'card_load', CAST($4 AS uuid),
             CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS timestamptz))
     ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
    [a.driverId, a.amountCents, deficitNote(a), a.transactionId, namedBy, proposalId, nowIso],
  );
  const rows = await q.query<{ driver_id: string; amount_cents: string; source_id: string }>(
    `SELECT CAST(driver_id AS text) AS driver_id, CAST(amount_cents AS text) AS amount_cents,
            CAST(source_id AS text) AS source_id
       FROM driver_deficits
      WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
    [proposalId],
  );
  return (
    rows.length === 1 &&
    rows[0].driver_id === a.driverId &&
    Number(rows[0].amount_cents) === a.amountCents &&
    rows[0].source_id === a.transactionId
  );
}

async function apply(
  q: Queryable,
  session: Session,
  proposalId: string,
  opts: ApproveOptions,
  now: Date,
): Promise<ProposalResult> {
  await assertMembership(q, session);
  if ((await staffRole(q, session)) === null) return refused("role");
  const rows = await q.query<Locked>(
    `SELECT CAST(id AS text) AS id, kind, status, subject_table, CAST(subject_id AS text) AS subject_id,
            amount_cents, CAST(args AS text) AS args, CAST(approved_edits AS text) AS approved_edits
       FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId],
  );
  if (rows.length !== 1) return refused("not_found");
  const p = rows[0];
  if (p.kind !== "card_load_ruling") return refused("not_executable");
  if (p.status === "done") return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  if (p.status !== "approved" && p.status !== "executing") return refused("already_decided");
  const nowIso = now.toISOString();

  // The ruling from the stored edits only. A request's own edits must be the stored ones.
  const edits = storedEdits(p.approved_edits);
  if (edits === null) {
    await fail(q, p.id, "not_executable", nowIso);
    return refused("not_executable");
  }
  if (opts.edits !== undefined && !sameEdits(opts.edits, edits)) return refused("edits_changed");
  const a = argsOf(p.args);
  const ruling = a === null ? null : rulingOf(a, edits);
  if (!argsMatchRow(a, p.subject_table, p.subject_id, Number(p.amount_cents)) || ruling === null) {
    await fail(q, p.id, "not_executable", nowIso);
    return refused("not_executable");
  }
  if (!(await factsHold(q, a, p.id))) {
    await fail(q, p.id, "stale", nowIso);
    console.info(`proposal ${p.id} card_load_ruling refused=stale`);
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
  if (ruling === "deficit" && !(await bookDeficit(q, a, p.id, namedBy, nowIso))) {
    // Another row holds this proposal's deficit with other values: never adopted, never doubled.
    throw new Error("the ruling's deficit did not read back");
  }
  await resolveBreak(q, a.transactionId, nowIso);
  const n = await q.execute(
    `UPDATE proposals SET status = 'done', decision_note = $3, updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [p.id, nowIso, ruling],
  );
  if (n !== 1) throw new Error("the ruling's proposal did not move to done");
  console.info(`proposal ${p.id} card_load_ruling done ruling=${ruling}`);
  return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
}

// The gate's early refusal (see Precheck in execute.ts): inside the gate's transaction, with the
// proposal still proposed and locked. Reads only.
export const precheckCardLoadRuling: Precheck = async (q, proposal: ProposalRow, _now, ctx) => {
  if (flags.cardLoadRuling.enabled !== true) return refused("not_executable");
  if (proposal.kind !== "card_load_ruling") return refused("not_executable");
  if (!ctx) return refused("not_executable");
  if (machineLogin(ctx.session)) return refused("kind_never_alone");
  if ((await staffRole(q, ctx.session)) === null) return refused("role");
  const a = argsFrom(proposal.args);
  if (!argsMatchRow(a, proposal.subjectTable, proposal.subjectId, proposal.amountCents)) return refused("not_executable");
  if (rulingOf(a, ctx.opts.edits ?? null) === null) return refused("not_executable");
  if (editsUnconfirmed(ctx.opts)) return refused("needs_confirm");
  if (!(await factsHold(q, a, proposal.id))) {
    console.info(`proposal ${proposal.id} card_load_ruling precheck=stale`);
    return refused("stale");
  }
  if ((await memberOf(q, ctx.session)) === null) return refused("role");
  return null;
};

async function runCardLoadRuling(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  opts: ApproveOptions,
  deps: ExecuteDeps,
): Promise<ProposalResult> {
  if (flags.cardLoadRuling.enabled !== true) return refused("not_executable");
  if (proposal.kind !== "card_load_ruling") return refused("not_executable");
  if (machineLogin(session)) return refused("kind_never_alone");
  // A resume skips the gate, so the confirm is checked here too, before anything is read.
  if (editsUnconfirmed(opts)) return refused("needs_confirm");
  const now = (deps.clock ?? (() => new Date()))();
  return db.withTenant(session.tenantId, (q) => apply(q, session, proposal.id, opts, now));
}

export const cardLoadRulingExecutor: Executor = Object.assign(runCardLoadRuling, { precheck: precheckCardLoadRuling });
