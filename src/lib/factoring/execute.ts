import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { factoringAdapter } from "../adapters";
import type { FactoringAdapter, FactoringSubmission } from "../adapters/types";
import type { Session } from "../auth/claims";
import { factoringArgsOf, factoringArgsSchema, sameArgs, type FactoringArgs } from "../cash/args";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MoneyError, type MoneyAction } from "../money/types";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../proposals/execute";
import { factoringFor } from "../rules-engine/factoring";
import { assertMembership, ForbiddenError } from "../tenant/context";
import { localDateOf, type LocalDate } from "../time/local-date";
import { packetComplete, packetsOf } from "./packet";
import { readFactoringInput } from "./read";
import { factoringOn, submitGate } from "./switches";

// A person approves a factoring card, and only then is anything offered to the factoring partner
// (design 3.2). The proposal gate (src/lib/proposals/execute.ts) has checked the person, the role
// (a net above approverRole.adminAboveCents needs an admin), the auditor and the second confirm,
// and asked precheckFactoring while the card still waited. Then, in one tenant transaction with
// the proposal and the card's invoices locked (in id order), this executor asks the submit gate
// again, re-runs the rules engine as of now (a card whose invoices, balances or rates changed ends
// failed, nothing sent), writes the factoring_requests row and one factoring_request_invoices line
// per invoice (status 'submitted', the papers snapshot) and moves the proposal to executing.
//
// Each line then goes through the money executor on its own, in invoice-number order: one ledger
// row per invoice (kind factoring_advance, subject the invoice, counterparty its customer, amount
// the line's net; idempotency key factoring_advance:<invoice id>:<attempt>), reserved before the
// one call to the simulated partner and settled after it:
//   confirmed  the line 'funded' with the partner's reference, in the settle transaction
//   failed     the line 'declined' (the partner said no) or 'failed'; no money moved
//   unknown    the line 'unknown' until Check pending reads the row back; never sent twice
// When no line is left waiting, the request rolls up: every line funded 'funded', some
// 'partly_funded' (the proposal done either way), none 'declined' or 'failed' (the proposal
// failed). The money moves to the carrier only; nothing here pays a driver, posts to accounting or
// touches an invoice's balance (the customer still pays the invoice; the reserve comes back then).
//
// Lock order, the same in every transaction, so two approvals and a Check pending never wait on
// each other in a cycle: proposal, then invoices, then the money row, then the line, then the
// request. prepare takes proposal + invoices; the reserve takes the invoice, the money row and
// (onReserved) the line; the settle takes the money row and the line; closeRequest takes the
// proposal and the request and only reads the lines. The proposal is locked FOR NO KEY UPDATE,
// never FOR UPDATE: the reserve's money row insert holds an invoice and then takes a key share on
// the proposal through its foreign key, and FOR UPDATE would make that wait on a resumed prepare
// that in turn waits on the same invoice (a deadlock two concurrent approvals found).

export type FactoringDeps = ExecuteDeps & {
  money?: Partial<MoneyDeps>;
  adapter?: FactoringAdapter;
  newId?: () => string;
};

const NOTE_MAX = 240;
const MAX_ATTEMPT = 20;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`factoring: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

// Now, from the injected clock. The one place this file reads the wall clock is the default when
// no clock is injected; every stamp below is written from the value this returns.
const nowOf = (deps: FactoringDeps): Date => (deps.clock ?? (() => new Date()))();

const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown");

// ---- The card's args ----

// The proposal's args read whole: the schema's every field, the week the card names and the
// card's own amount. Anything else is not executable.
export function factoringArgsOfProposal(p: ProposalRow): FactoringArgs | null {
  if (p.kind !== "factoring_request" || p.subjectTable !== "settlement_periods") return null;
  const parsed = factoringArgsSchema.safeParse(p.args);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.periodId !== p.subjectId || a.amountCents !== p.amountCents) return null;
  return a;
}

const invoiceIdsOf = (a: FactoringArgs) => a.invoices.map((i) => i.invoiceId);

// The rules engine as of today on this carrier's records, compared whole with the card's args.
// A read or engine error throws; callers treat it as unknown, never as the same.
async function sameAsEngine(q: Queryable, a: FactoringArgs, today: LocalDate): Promise<boolean> {
  const input = await readFactoringInput(q, a.periodId);
  const { factoringMaxAgeDays, maxFactorInvoices } = flags.cashFridayLimits;
  const d = factoringFor(
    input,
    invoiceIdsOf(a),
    today,
    { maxAgeDays: factoringMaxAgeDays, maxInvoices: maxFactorInvoices },
    a.shortCents,
  );
  if (!d.ok) return false;
  return sameArgs(a, factoringArgsOf(d.option, a.payDay, a.shortCents));
}

async function periodExists(q: Queryable, periodId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [periodId],
  );
  return rows.length === 1;
}

// A factoring ledger row still open or confirmed for any of these invoices (one not failed).
async function liveAdvanceExists(q: Queryable, invoiceIds: readonly string[]): Promise<boolean> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM money_actions
      WHERE tenant_id = current_tenant_id() AND kind = 'factoring_advance' AND state <> 'failed'
        AND subject_id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`,
    [JSON.stringify(invoiceIds)],
  );
  return Number(rows[0]?.n ?? 1) !== 0;
}

async function packetsComplete(q: Queryable, invoiceIds: readonly string[]): Promise<boolean> {
  const packets = await packetsOf(q, invoiceIds);
  return invoiceIds.every((id) => {
    const p = packets.get(id);
    return p !== undefined && packetComplete(p);
  });
}

async function memberId(q: Queryable, session: Session): Promise<string> {
  await assertMembership(q, session);
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (rows.length !== 1) throw new Stop("forbidden");
  return rows[0].id;
}

// A factoring card that ends without a request going out, with a note code the record says in
// words. Only from approved or executing, the two states the proposal guard lets move to failed.
function failProposal(
  q: Queryable,
  proposalId: string,
  note: string,
  nowIso: string,
  moneyActionId: string | null = null,
): Promise<number> {
  return q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz),
            money_action_id = COALESCE(money_action_id, CAST($4 AS uuid))
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'factoring_request'
        AND status IN ('approved', 'executing')`,
    [proposalId, note.slice(0, NOTE_MAX), nowIso, moneyActionId],
  );
}

// A refusal whose transaction rolled back (a unique index refused a write, so nothing was
// written): the card ends in a short transaction of its own, the way the other refusals end it.
// Only while it is still approved with no request behind it, so a run of the same card that got
// further in the meantime is never ended under it. A failure here leaves the card approved, and
// approving again runs the checks again.
async function failRolledBack(
  db: TenantDb,
  session: Session,
  proposalId: string,
  note: string,
  nowIso: string,
): Promise<void> {
  try {
    await db.withTenant(session.tenantId, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'factoring_request'
            AND status = 'approved'
            AND NOT EXISTS (SELECT 1 FROM factoring_requests r
                             WHERE r.tenant_id = current_tenant_id() AND r.proposal_id = CAST($1 AS uuid))`,
        [proposalId, note.slice(0, NOTE_MAX), nowIso],
      ),
    );
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
    console.error("factoring card could not be closed:", errName(err));
  }
}

// ---- Requests and lines ----

type RequestRow = {
  id: string;
  proposal_id: string | null;
  status: string;
  balance_cents: number | string;
  advance_cents: number | string;
  fee_cents: number | string;
  net_cents: number | string;
  reserve_cents: number | string;
};

type Request = {
  id: string;
  proposalId: string | null;
  status: string;
  balanceCents: number;
  advanceCents: number;
  feeCents: number;
  netCents: number;
  reserveCents: number;
};

function whole(v: number | string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new MoneyError("validation");
  return n;
}

function requestOf(r: RequestRow): Request {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    status: r.status,
    balanceCents: whole(r.balance_cents),
    advanceCents: whole(r.advance_cents),
    feeCents: whole(r.fee_cents),
    netCents: whole(r.net_cents),
    reserveCents: whole(r.reserve_cents),
  };
}

const REQUEST_COLUMNS =
  "CAST(id AS text) AS id, CAST(proposal_id AS text) AS proposal_id, status, balance_cents, advance_cents," +
  " fee_cents, net_cents, reserve_cents";

async function requestBy(
  q: Queryable,
  column: "id" | "proposal_id",
  id: string,
  lock: boolean,
): Promise<Request | null> {
  const rows = await q.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM factoring_requests
      WHERE tenant_id = current_tenant_id() AND ${column} = CAST($1 AS uuid)${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? requestOf(rows[0]) : null;
}

export type Line = {
  id: string;
  requestId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  attempt: number;
  balanceCents: number;
  advanceCents: number;
  feeCents: number;
  netCents: number;
  reserveCents: number;
  status: string;
  moneyActionId: string | null;
};

type LineRow = {
  id: string;
  request_id: string;
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  attempt: number | string;
  balance_cents: number | string;
  advance_cents: number | string;
  fee_cents: number | string;
  net_cents: number | string;
  reserve_cents: number | string;
  status: string;
  money_action_id: string | null;
};

function lineOf(r: LineRow): Line {
  return {
    id: r.id,
    requestId: r.request_id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    attempt: whole(r.attempt),
    balanceCents: whole(r.balance_cents),
    advanceCents: whole(r.advance_cents),
    feeCents: whole(r.fee_cents),
    netCents: whole(r.net_cents),
    reserveCents: whole(r.reserve_cents),
    status: r.status,
    moneyActionId: r.money_action_id,
  };
}

// A request's lines in invoice-number order (the order they are sent in). Read, never locked.
async function linesOf(q: Queryable, requestId: string): Promise<Line[]> {
  const rows = await q.query<LineRow>(
    `SELECT CAST(l.id AS text) AS id, CAST(l.request_id AS text) AS request_id,
            CAST(l.invoice_id AS text) AS invoice_id, i.invoice_number, CAST(i.customer_id AS text) AS customer_id,
            l.attempt, l.balance_cents, l.advance_cents, l.fee_cents, l.net_cents, l.reserve_cents, l.status,
            CAST(l.money_action_id AS text) AS money_action_id
       FROM factoring_request_invoices l
       JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
      WHERE l.tenant_id = current_tenant_id() AND l.request_id = CAST($1 AS uuid)
      ORDER BY i.invoice_number, l.attempt, l.id`,
    [requestId],
  );
  return rows.map(lineOf);
}

// The stored request says what the card said, cent for cent.
function requestMatches(r: Request, a: FactoringArgs): boolean {
  return (
    r.balanceCents === a.balanceCents &&
    r.advanceCents === a.advanceCents &&
    r.feeCents === a.feeCents &&
    r.netCents === a.amountCents &&
    r.reserveCents === a.reserveCents
  );
}

// ---- The ledger hooks ----

const PROVIDER_REF = /^fsim_adv_[0-9a-f]{24}$/;

// The partner's submission, built from the stored line and the ledger row only.
function submissionOf(action: MoneyAction, line: Line): FactoringSubmission {
  return {
    actionId: action.id,
    invoiceNumber: line.invoiceNumber,
    customerCode: line.customerId,
    balanceCents: line.balanceCents,
    advanceCents: line.advanceCents,
    feeCents: line.feeCents,
    netCents: line.netCents,
    reserveCents: line.reserveCents,
  };
}

// In the reserve transaction, with the invoice already locked by the ledger (its customer the
// row's counterparty, its status open or partly paid): the line names its ledger row, and only
// while the invoice is still a load's and still owes exactly the balance the line was priced on.
// A throw rolls the reservation back, so nothing is sent for an invoice that changed.
async function onLineReserved(q: Queryable, action: MoneyAction): Promise<void> {
  const changed = await q.execute(
    `UPDATE factoring_request_invoices l SET money_action_id = CAST($3 AS uuid)
      WHERE l.tenant_id = current_tenant_id() AND l.invoice_id = CAST($1 AS uuid) AND l.attempt = $2
        AND l.status = 'submitted' AND l.money_action_id IS NULL AND l.net_cents = $4
        AND l.balance_cents = (
          SELECT i.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM payment_applications a
                                             WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id), 0)
            FROM invoices i
           WHERE i.tenant_id = l.tenant_id AND i.id = l.invoice_id AND i.source = 'load'
             AND i.status IN ('open', 'partially_paid'))`,
    [action.subjectId, action.attempt, action.id, action.amountCents],
  );
  if (changed !== 1) throw new MoneyError("validation");
}

// The post-confirm step, in the settle transaction (the executor's or the reconcile pass's).
// Idempotent: a line already funded by this same row with this same reference is left as it is. A
// line no longer waiting (called off while the advance went out) throws, so the ledger row stays
// open for a person.
export async function finishFundedLine(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  if (action.kind !== "factoring_advance" || action.state !== "confirmed") throw new MoneyError("validation");
  const ref = action.outsideId;
  if (typeof ref !== "string" || !PROVIDER_REF.test(ref)) throw new MoneyError("validation");
  const changed = await q.execute(
    `UPDATE factoring_request_invoices
        SET status = 'funded', provider_ref = $3, settled_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND money_action_id = CAST($1 AS uuid)
        AND status IN ('submitted', 'unknown') AND net_cents = $2`,
    [action.id, action.amountCents, ref, action.settledAt ?? nowIso],
  );
  if (changed === 1) return;
  const rows = await q.query<{ status: string; provider_ref: string | null }>(
    `SELECT status, provider_ref FROM factoring_request_invoices
      WHERE tenant_id = current_tenant_id() AND money_action_id = CAST($1 AS uuid)`,
    [action.id],
  );
  if (rows.length === 1 && rows[0].status === "funded" && rows[0].provider_ref === ref) return;
  throw new MoneyError("validation");
}

// A definite no: no money moved for this invoice. The partner's decline reads as declined; any
// other failure (a refusal before the call, a bad answer) as failed.
async function onLineFailed(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE factoring_request_invoices
        SET status = CASE WHEN CAST($2 AS text) = 'declined' THEN 'declined' ELSE 'failed' END,
            settled_at = COALESCE(settled_at, CAST($3 AS timestamptz))
      WHERE tenant_id = current_tenant_id() AND money_action_id = CAST($1 AS uuid)
        AND status IN ('submitted', 'unknown')`,
    [action.id, action.failureCategory ?? "unknown", action.settledAt ?? nowIso],
  );
}

function sendHooks(adapter: FactoringAdapter, line: Line, requestNetCents: number, nowIso: string): MoneyHooks {
  return {
    onReserved: onLineReserved,
    onConfirmed: (q, action) => finishFundedLine(q, action, nowIso),
    onFailed: (q, action) => onLineFailed(q, action, nowIso),
    ready: () => adapter.ready(),
    // The feature switches at the write, on top of the money executor's payoutsEnabled; the
    // partner asks them again itself.
    send: async (action, ctx) => {
      if (!factoringOn()) return { kind: "failed", category: "disabled" };
      if (submitGate(requestNetCents, localDateOf(nowIso, ctx.tenantZone)) !== null) {
        return { kind: "failed", category: "disabled" };
      }
      if (action.amountCents !== line.netCents || action.subjectId !== line.invoiceId) {
        return { kind: "failed", category: "validation" };
      }
      return adapter.submitInvoice(submissionOf(action, line), ctx);
    },
  };
}

export function lineReconcileHooks(adapter: FactoringAdapter, line: Line, nowIso: string): ReconcileHooks {
  return {
    onConfirmed: (q, action) => finishFundedLine(q, action, nowIso),
    onFailed: (q, action) => onLineFailed(q, action, nowIso),
    ready: () => adapter.ready(),
    readBack: (action, ctx) =>
      adapter.readBack(
        { requestId: action.requestId, outsideId: action.outsideId, request: submissionOf(action, line) },
        ctx,
      ),
  };
}

// ---- Approval ----

// The gate's early refusal (Precheck in src/lib/proposals/execute.ts), under the gate's proposal
// lock before the proposal becomes approved: a refusal leaves the card waiting, with nothing
// written. Reads only. The executor asks all of it again after the approval.
export async function precheckFactoring(q: Queryable, p: ProposalRow, now: Date): Promise<ProposalRefused | null> {
  if (!factoringOn()) return no("factoring_off");
  const a = factoringArgsOfProposal(p);
  if (!a) return no("not_executable");
  const today = localDateOf(now.toISOString(), await readTenantZone(q));
  const refusal = submitGate(a.amountCents, today);
  if (refusal) return no(refusal);
  if (!(await periodExists(q, a.periodId))) return no("not_found");
  if (await requestBy(q, "proposal_id", p.id, false)) return no("already_decided");
  const ids = invoiceIdsOf(a);
  try {
    if (!(await sameAsEngine(q, a, today))) return no("invoices_changed");
    if (await liveAdvanceExists(q, ids)) return no("invoices_changed");
    if (flags.factoring.requirePacket && !(await packetsComplete(q, ids))) return no("packet_incomplete");
  } catch {
    return no("factoring_check_unavailable", true);
  }
  return null;
}

type Prepared =
  | { kind: "send"; request: Request; lines: Line[] }
  | { kind: "refused"; category: string };

async function insertRequest(
  q: Queryable,
  session: Session,
  p: ProposalRow,
  a: FactoringArgs,
  ids: readonly string[],
  nowIso: string,
  newId: () => string,
): Promise<void> {
  const packets = await packetsOf(q, ids);
  const requestId = newId();
  const inserted = await q.execute(
    `INSERT INTO factoring_requests (id, tenant_id, period_id, proposal_id, membership_id, provider, advance_bps,
                                     fee_bps, balance_cents, advance_cents, fee_cents, net_cents, reserve_cents,
                                     status, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
             'factoring_sim', $5, $6, $7, $8, $9, $10, $11, 'submitted', CAST($12 AS timestamptz))
     ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
    [
      requestId,
      a.periodId,
      p.id,
      await memberId(q, session),
      a.advanceBps,
      a.feeBps,
      a.balanceCents,
      a.advanceCents,
      a.feeCents,
      a.amountCents,
      a.reserveCents,
      nowIso,
    ],
  );
  if (inserted !== 1) return;
  for (const inv of a.invoices) {
    // Under the invoice lock, so two requests never take the same attempt for one invoice.
    const next = await q.query<{ n: number | string }>(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM factoring_request_invoices
        WHERE tenant_id = current_tenant_id() AND invoice_id = CAST($1 AS uuid)`,
      [inv.invoiceId],
    );
    const attempt = Number(next[0]?.n);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPT) throw new Stop("not_executable");
    await q.execute(
      `INSERT INTO factoring_request_invoices (id, tenant_id, request_id, invoice_id, attempt, balance_cents,
                                               advance_cents, fee_cents, net_cents, reserve_cents, status, packet,
                                               created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, $6, $7, $8, $9,
               'submitted', CAST($10 AS jsonb), CAST($11 AS timestamptz))`,
      [
        newId(),
        requestId,
        inv.invoiceId,
        attempt,
        inv.balanceCents,
        inv.advanceCents,
        inv.feeCents,
        inv.netCents,
        inv.reserveCents,
        JSON.stringify(packets.get(inv.invoiceId) ?? null),
        nowIso,
      ],
    );
  }
}

async function prepare(
  q: Queryable,
  session: Session,
  p: ProposalRow,
  a: FactoringArgs,
  now: Date,
  newId: () => string,
): Promise<Prepared> {
  const locked = await q.query<{ status: string }>(
    `SELECT status FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'factoring_request'
      FOR NO KEY UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const status = locked[0].status;
  if (status === "proposed") throw new Stop("not_executable");
  if (status !== "approved" && status !== "executing") throw new Stop("already_decided");

  const nowIso = now.toISOString();
  const today = localDateOf(nowIso, await readTenantZone(q));
  const refusal = submitGate(a.amountCents, today);
  if (refusal) throw new Stop(refusal);
  if (!(await periodExists(q, a.periodId))) throw new Stop("not_found");

  // The card's invoices, locked in id order (the order every transaction takes them in).
  const ids = invoiceIdsOf(a);
  const lockedInvoices = await q.query<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM invoices
      WHERE tenant_id = current_tenant_id()
        AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)
      ORDER BY id
      FOR UPDATE`,
    [JSON.stringify([...ids].sort())],
  );

  let request = await requestBy(q, "proposal_id", p.id, false);
  if (!request) {
    if (lockedInvoices.length !== ids.length) {
      await failProposal(q, p.id, "refused: invoices_changed", nowIso);
      return { kind: "refused", category: "invoices_changed" };
    }
    // The engine again, as of now and under the invoice locks. Asked only before the request is
    // written: once its lines exist, the invoices read as factored, by this very request.
    let same: boolean;
    let live: boolean;
    let papers = true;
    try {
      same = await sameAsEngine(q, a, today);
      live = await liveAdvanceExists(q, ids);
      if (flags.factoring.requirePacket) papers = await packetsComplete(q, ids);
    } catch {
      throw new Stop("factoring_check_unavailable", true);
    }
    if (!same || live || !papers) {
      // The facts changed since the card: nothing sent. Written and returned (the commit keeps
      // it), so the card and the record say why.
      const category = !same || live ? "invoices_changed" : "packet_incomplete";
      await failProposal(q, p.id, `refused: ${category}`, nowIso);
      return { kind: "refused", category };
    }
    await insertRequest(q, session, p, a, ids, nowIso, newId);
    request = await requestBy(q, "proposal_id", p.id, false);
    if (!request) throw new DbError("unknown");
  }
  if (!requestMatches(request, a)) throw new Stop("not_executable");
  if (status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  return { kind: "send", request, lines: await linesOf(q, request.id) };
}

// After a refusal before this line's ledger row was reserved (a switch went off, the partner was
// not ready, the invoice changed): the line ends failed, so nothing is left submitted with no row.
// Only while it has no ledger row: a row reserved in the meantime keeps the line for Check pending.
async function abandonLine(db: TenantDb, session: Session, lineId: string, nowIso: string): Promise<void> {
  try {
    await db.withTenant(session.tenantId, (q) =>
      q.execute(
        `UPDATE factoring_request_invoices SET status = 'failed', settled_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'submitted'
            AND money_action_id IS NULL`,
        [lineId, nowIso],
      ),
    );
  } catch (err) {
    console.error("factoring line could not be closed:", errName(err));
  }
}

// A send whose outcome is not known yet reads as unknown on the line until Check pending.
async function markLineUnknown(db: TenantDb, session: Session, lineId: string): Promise<void> {
  try {
    await db.withTenant(session.tenantId, (q) =>
      q.execute(
        `UPDATE factoring_request_invoices SET status = 'unknown'
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'submitted'
            AND money_action_id IS NOT NULL`,
        [lineId],
      ),
    );
  } catch (err) {
    console.error("factoring line status could not be written:", errName(err));
  }
}

// A MoneyError thrown before a row was reserved, in the card's words.
const GATE_OF_MONEY: Readonly<Record<string, string>> = {
  disabled: "factoring_off",
  validation: "invoices_changed",
};

type Sent = { state: "funded" | "declined" | "failed" | "pending" } | { state: "refused"; category: string };

async function sendLine(
  db: TenantDb,
  session: Session,
  line: Line,
  request: Request,
  proposal: ProposalRow,
  deps: FactoringDeps,
  adapter: FactoringAdapter,
): Promise<Sent> {
  const nowIso = nowOf(deps).toISOString();
  // The submit gate once more, right before the money executor: the executor itself re-checks
  // only payoutsEnabled and the partner. A refusal here is a definite no with nothing reserved.
  let refusal: string | null;
  try {
    const zone = await db.withTenant(session.tenantId, (q) => readTenantZone(q));
    refusal = submitGate(request.netCents, localDateOf(nowIso, zone));
  } catch (err) {
    console.error("factoring gate could not be read:", errName(err));
    return { state: "refused", category: "factoring_unavailable" };
  }
  if (refusal) {
    await abandonLine(db, session, line.id, nowIso);
    return { state: "refused", category: refusal };
  }
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "factoring_advance",
        subjectId: line.invoiceId,
        counterpartyId: line.customerId,
        amountCents: line.netCents,
        attempt: line.attempt,
        // A chat proposal is the agent's; a card made by the rules engine (no conversation) is
        // approved from the Cash page by a person.
        proposedBy: proposal.conversationId === null ? "person" : "agent",
        proposalId: proposal.id,
        traceId: isCanonicalUuid(proposal.traceId) ? proposal.traceId : null,
        subjectStatuses: ["open", "partially_paid"],
      },
      sendHooks(adapter, line, request.netCents, nowIso),
      deps.money,
    );
    if (r.action.state === "confirmed") return { state: "funded" };
    if (r.action.state === "failed") return { state: r.action.failureCategory === "declined" ? "declined" : "failed" };
    if (r.action.state === "unknown" || r.action.state === "sent") await markLineUnknown(db, session, line.id);
    return { state: "pending" };
  } catch (err) {
    if (err instanceof MoneyError) {
      // Thrown before a row was reserved (a switch off, the partner not ready, the invoice
      // changed): nothing went out. "unknown" is the one exception: the send happened and even
      // the read of its row failed, so it stays pending for Check pending.
      if (err.category === "unknown") {
        await markLineUnknown(db, session, line.id);
        return { state: "pending" };
      }
      await abandonLine(db, session, line.id, nowIso);
      return { state: "refused", category: GATE_OF_MONEY[err.category] ?? "factoring_unavailable" };
    }
    if (err instanceof ForbiddenError) throw err;
    console.error("factoring send did not finish:", errName(err));
    // Not always before a send: money may have moved. Unknown, never a retry.
    await markLineUnknown(db, session, line.id);
    return { state: "pending" };
  }
}

// ---- The roll-up ----

export type Rollup = {
  status: "submitted" | "unknown" | "funded" | "partly_funded" | "declined" | "failed";
  moneyActionId: string | null;
};

// Once no line is waiting, the request takes its final status and the proposal closes: done when
// any invoice was funded, failed when none was, recording the first funded line's ledger row (else
// the first line's) in invoice-number order. While a line waits, the request reads unknown (or
// submitted, when nothing has gone out yet) and the proposal stays executing. Idempotent.
export async function closeRequest(q: Queryable, requestId: string, nowIso: string): Promise<Rollup | null> {
  const head = await requestBy(q, "id", requestId, false);
  if (!head) return null;
  let proposalStatus: string | null = null;
  if (head.proposalId) {
    const p = await q.query<{ status: string }>(
      `SELECT status FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'factoring_request'
        FOR NO KEY UPDATE`,
      [head.proposalId],
    );
    proposalStatus = p[0]?.status ?? null;
  }
  const request = await requestBy(q, "id", requestId, true);
  if (!request) return null;
  const lines = await linesOf(q, requestId);
  const firstAction = lines.find((l) => l.moneyActionId !== null)?.moneyActionId ?? null;
  const fundedAction = lines.find((l) => l.status === "funded")?.moneyActionId ?? null;
  const waiting = lines.filter((l) => l.status === "submitted" || l.status === "unknown");
  const funded = lines.filter((l) => l.status === "funded").length;

  let status: Rollup["status"];
  if (lines.length === 0) status = "failed";
  else if (waiting.length > 0) status = waiting.some((l) => l.status === "unknown") ? "unknown" : "submitted";
  else if (funded === lines.length) status = "funded";
  else if (funded > 0) status = "partly_funded";
  else if (lines.every((l) => l.status === "declined")) status = "declined";
  else status = "failed";

  const isFunded = status === "funded" || status === "partly_funded";
  await q.execute(
    `UPDATE factoring_requests
        SET status = $2,
            funded_at = CASE WHEN CAST($3 AS boolean) THEN COALESCE(funded_at, CAST($4 AS timestamptz)) ELSE NULL END
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [requestId, status, isFunded, nowIso],
  );

  const moneyActionId = fundedAction ?? firstAction;
  const proposalId = request.proposalId;
  if (proposalId && (proposalStatus === "approved" || proposalStatus === "executing")) {
    if (proposalStatus === "approved") {
      await q.execute(
        `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
        [proposalId, nowIso],
      );
    }
    if (isFunded) {
      await q.execute(
        `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz),
                money_action_id = COALESCE(money_action_id, CAST($3 AS uuid))
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
        [proposalId, nowIso, moneyActionId],
      );
    } else if (status === "declined" || status === "failed") {
      await failProposal(q, proposalId, `factoring_${status}`, nowIso, moneyActionId);
    }
    // While a line waits the proposal names no ledger row: one line's confirmed row would make
    // the card read done before the others are known.
  }
  return { status, moneyActionId };
}

function resultOf(proposalId: string, rollup: Rollup, refusal: string | null): ProposalResult {
  if (rollup.status === "funded" || rollup.status === "partly_funded") {
    return { ok: true, proposalId, status: "done", moneyActionId: rollup.moneyActionId };
  }
  if (rollup.status === "declined") return no("factoring_declined");
  if (rollup.status === "failed") return no(refusal ?? "factoring_failed");
  // Nothing has gone out yet (the gate could not be read): approving again picks up from here.
  if (rollup.status === "submitted") return no(refusal ?? "factoring_unavailable", true);
  return { ok: true, proposalId, status: "executing", moneyActionId: rollup.moneyActionId };
}

export const executeFactoringRequest: Executor = async (
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: FactoringDeps,
): Promise<ProposalResult> => {
  if (!factoringOn()) return no("factoring_off");
  const a = factoringArgsOfProposal(proposal);
  if (!a) return no("not_executable");
  const now = nowOf(deps);
  const newId = deps.newId ?? randomUUID;
  let prepared: Prepared;
  try {
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, session, proposal, a, now, newId));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    if (err instanceof DbError && err.sqlState === "23505") {
      // Another live line took one of these invoices first (factoring_one_live_per_invoice).
      await failRolledBack(db, session, proposal.id, "refused: invoices_changed", now.toISOString());
      return no("invoices_changed");
    }
    throw err;
  }
  if (prepared.kind === "refused") return no(prepared.category);
  const adapter = deps.adapter ?? factoringAdapter();
  // The first refusal, so a request every line of which was refused says why.
  let refusal: string | null = null;
  for (const line of prepared.lines) {
    if (line.status !== "submitted") continue;
    const sent = await sendLine(db, session, line, prepared.request, proposal, deps, adapter);
    if (sent.state === "refused") refusal ??= sent.category;
  }
  const nowIso = nowOf(deps).toISOString();
  let rollup: Rollup | null;
  try {
    rollup = await db.withTenant(session.tenantId, (q) => closeRequest(q, prepared.request.id, nowIso));
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
    console.error("factoring request could not be rolled up:", errName(err));
    return no("factoring_pending");
  }
  if (!rollup) return no("factoring_pending");
  return resultOf(proposal.id, rollup, refusal);
};

export const factoringRequestExecutor: Executor = Object.assign(
  (...args: Parameters<Executor>) => executeFactoringRequest(...args),
  { precheck: precheckFactoring },
);

// ---- Check pending ----

// The reconcile pass reads back a row still sent only once it is this old (an unknown row at
// once), so a send still in flight is not read back as if it had been lost.
const CHECK_AFTER_SECONDS = 60;

export type CheckResult =
  | { ok: true; summary: ReconcileSummary; tooNew: number; stillWaiting: number; status: Rollup["status"] }
  | { ok: false; category: string; retryable: boolean };

const EMPTY_SUMMARY: ReconcileSummary = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };

function addSummary(a: ReconcileSummary, b: ReconcileSummary): ReconcileSummary {
  return {
    checked: a.checked + b.checked,
    confirmed: a.confirmed + b.confirmed,
    failed: a.failed + b.failed,
    stillUnknown: a.stillUnknown + b.stillUnknown,
    skipped: a.skipped + b.skipped,
    errors: a.errors + b.errors,
  };
}

// Check pending: the reconcile pass over each waiting line's own ledger row, read back by its
// request id. Never sends anything new; a line found funded gets the same finishFundedLine the
// approval would have run, and the request rolls up after. A person asked, so the read-back runs
// even past the automatic check limit; it stays read-only toward the partner.
export async function checkPendingFactoring(
  session: Session,
  requestId: string,
  deps: FactoringDeps = {},
): Promise<CheckResult> {
  if (!factoringOn()) return no("factoring_off");
  if (!isCanonicalUuid(requestId)) return no("not_found");
  const db = deps.db ?? getDb();
  const nowIso = nowOf(deps).toISOString();
  const lines = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    if (!(await requestBy(q, "id", requestId, false))) return null;
    return linesOf(q, requestId);
  });
  if (!lines) return no("not_found");
  const adapter = deps.adapter ?? factoringAdapter();
  let summary = EMPTY_SUMMARY;
  let tooNew = 0;
  let stillWaiting = 0;
  for (const line of lines) {
    if (line.moneyActionId === null || (line.status !== "submitted" && line.status !== "unknown")) continue;
    const s = await reconcileMoneyActions(
      db,
      session,
      {
        hooks: { factoring_advance: lineReconcileHooks(adapter, line, nowIso) },
        limit: 5,
        olderThanSeconds: CHECK_AFTER_SECONDS,
        subject: { table: "invoices", id: line.invoiceId },
        ignoreCheckLimit: true,
      },
      deps.money,
    );
    summary = addSummary(summary, s);
    if (s.checked === 0) {
      const rows = await db.withTenant(session.tenantId, (q) => readBySubject(q, "invoices", line.invoiceId));
      for (const r of rows) {
        if (r.kind !== "factoring_advance" || r.id !== line.moneyActionId) continue;
        if (r.state === "sent" && r.sentSecondsAgo !== null && r.sentSecondsAgo <= CHECK_AFTER_SECONDS) tooNew += 1;
        else if (r.state === "sent" || r.state === "unknown") stillWaiting += 1;
      }
    }
  }
  const rollup = await db.withTenant(session.tenantId, (q) => closeRequest(q, requestId, nowIso));
  if (!rollup) return no("not_found");
  return { ok: true, summary, tooNew, stillWaiting, status: rollup.status };
}
