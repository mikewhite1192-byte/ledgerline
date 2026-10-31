import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { moneyCodeIssuer } from "../adapters";
import type { MoneyCodeIssuer, MoneyCodeRequest } from "../adapters/types";
import type { Session } from "../auth/claims";
import { readMoneyCodeInput } from "../data/read";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "../money/execute";
import { isCanonicalUuid, memoCodeOf } from "../money/keys";
import { readBySubject, readTenantZone } from "../money/read";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MoneyError, type MoneyAction } from "../money/types";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  PrecheckContext,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../proposals/execute";
import {
  checkMoneyCode,
  MONEY_CODE_PURPOSES,
  MONEY_CODE_SOURCES,
  type MoneyCodeDecision,
  type MoneyCodePurpose,
  type MoneyCodeSource,
} from "../rules-engine/money-codes";
import { assertMembership, ForbiddenError } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { issueGate, moneyCodesOn } from "./switches";

// A person approves a money_code proposal, and only then is a code asked for (design 3.3). The
// proposal gate (src/lib/proposals/execute.ts) has checked the person, the role (an amount above
// approverRole.adminAboveCents needs an admin), the auditor and the second confirm, and asked
// precheckMoneyCode while the proposal still waited. Then, in one tenant transaction with the
// proposal, the driver and the load locked (a resume whose code is already written locks only the
// proposal and reads the arming), this executor asks the issue gate again, re-runs
// checkMoneyCode as of now (a proposal whose facts no longer hold ends failed, nothing issued),
// writes the money_codes row as 'issuing' (one per proposal: money_codes_one_per_proposal) and
// moves the proposal to executing. The money executor then reserves the ledger row (idempotency
// key money_code_issue:<code id>:1, request id = the row id without dashes), makes the one call
// to the simulated issuer and settles it:
//   confirmed  finishIssuedCode, in the settle transaction: the code 'issued' with the provider's
//              reference, the last four digits and expires_at = issued_at + 24 h; for a lumper one
//              billable lumper accessorial on the load (paid by the driver); two pay items that net
//              to zero (the code as a charge, the receipt as a reimbursement), keyed by item_ref
//              money_code:<code id>:charge and :reimbursement; the proposal done
//   failed     the code 'failed' and the proposal failed; nothing else is written
//   unknown    the code 'unknown'; nothing is written until Check pending reads the row back
//              and confirms it (the same finishIssuedCode), never a second issue
// The code itself is never stored or logged: the issuer derives it from the request id, and only
// the record page asks for it (revealMoneyCode).

export type MoneyCodeDeps = ExecuteDeps & {
  money?: Partial<MoneyDeps>;
  issuer?: MoneyCodeIssuer;
  newId?: () => string;
};

export type CodeResult =
  | { ok: true; codeId: string; status: string; moneyActionId: string | null }
  | { ok: false; category: string; retryable: boolean };

const NOTE_MAX = 240;
// One code is good for a day once issued.
const CODE_LIFETIME_MS = 24 * 60 * 60 * 1000;

class Stop extends Error {
  readonly result: { ok: false; category: string; retryable: boolean };
  constructor(category: string, retryable = false) {
    super(`money codes: ${category}`);
    this.name = "Stop";
    this.result = { ok: false, category, retryable };
  }
}

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

// Now, from the injected clock. The one place this file reads the wall clock is the default when
// no clock is injected; every stamp below is written from the value this returns.
const nowOf = (deps: MoneyCodeDeps): Date => (deps.clock ?? (() => new Date()))();

// ---- The proposal's args ----

type CodeArgs = {
  driverId: string;
  loadId: string;
  amountCents: number;
  purpose: MoneyCodePurpose;
  source: MoneyCodeSource;
  documentId: string | null;
  voiceNoteId: string | null;
  inputId: string | null;
};

const idOrNull = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : isCanonicalUuid(v) ? v : undefined;

// The proposal's args read whole: every field the right shape, the evidence present exactly when
// the source needs it, the amount the proposal's own. Anything else is not executable.
export function codeArgsOf(p: ProposalRow): CodeArgs | null {
  const a = p.args;
  const documentId = idOrNull(a.documentId);
  const voiceNoteId = idOrNull(a.voiceNoteId);
  const inputId = idOrNull(a.inputId);
  if (
    p.kind !== "money_code" ||
    p.subjectTable !== "loads" ||
    !isCanonicalUuid(p.subjectId) ||
    a.loadId !== p.subjectId ||
    !isCanonicalUuid(a.driverId) ||
    !Number.isSafeInteger(p.amountCents) ||
    p.amountCents <= 0 ||
    a.amountCents !== p.amountCents ||
    !(MONEY_CODE_PURPOSES as readonly unknown[]).includes(a.purpose) ||
    !(MONEY_CODE_SOURCES as readonly unknown[]).includes(a.source) ||
    documentId === undefined ||
    voiceNoteId === undefined ||
    inputId === undefined ||
    (a.source === "document") !== (documentId !== null) ||
    (a.source === "voice_note") !== (voiceNoteId !== null)
  ) {
    return null;
  }
  return {
    driverId: a.driverId,
    loadId: p.subjectId,
    amountCents: p.amountCents,
    purpose: a.purpose as MoneyCodePurpose,
    source: a.source as MoneyCodeSource,
    documentId,
    voiceNoteId,
    inputId,
  };
}

// The rules engine as of now on the stored args. A read or engine error throws; callers treat it
// as unknown, never as allowed.
async function checkNow(q: Queryable, a: CodeArgs, nowIso: string): Promise<MoneyCodeDecision> {
  const { capCents, perDriverPerDay } = flags.moneyCodes;
  const input = await readMoneyCodeInput(
    q,
    {
      driverId: a.driverId,
      loadId: a.loadId,
      purpose: a.purpose,
      amountCents: a.amountCents,
      source: a.source,
      documentId: a.documentId,
      voiceNoteId: a.voiceNoteId,
      capCents,
      perDriverPerDay,
    },
    nowIso,
  );
  return checkMoneyCode(input);
}

// ---- Shared reads ----

type CodeLock = {
  id: string;
  driverId: string;
  loadId: string;
  purpose: MoneyCodePurpose;
  amountCents: number;
  status: string;
  proposalId: string | null;
};

type CodeRaw = {
  id: string;
  driver_id: string;
  load_id: string;
  purpose: string;
  amount_cents: number | string;
  status: string;
  proposal_id: string | null;
};

function lockOf(r: CodeRaw): CodeLock {
  const amount = Number(r.amount_cents);
  if (!Number.isSafeInteger(amount)) throw new MoneyError("validation");
  if (!(MONEY_CODE_PURPOSES as readonly string[]).includes(r.purpose)) throw new MoneyError("validation");
  return {
    id: r.id,
    driverId: r.driver_id,
    loadId: r.load_id,
    purpose: r.purpose as MoneyCodePurpose,
    amountCents: amount,
    status: r.status,
    proposalId: r.proposal_id,
  };
}

const CODE_COLUMNS =
  "CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, CAST(load_id AS text) AS load_id," +
  " purpose, amount_cents, status, CAST(proposal_id AS text) AS proposal_id";

async function codeBy(q: Queryable, column: "id" | "proposal_id", id: string, lock: boolean): Promise<CodeLock | null> {
  const rows = await q.query<CodeRaw>(
    `SELECT ${CODE_COLUMNS} FROM money_codes
      WHERE tenant_id = current_tenant_id() AND ${column} = CAST($1 AS uuid)${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? lockOf(rows[0]) : null;
}

// Whether the driver is armed to receive money: null when there is no such driver here.
async function driverArmed(q: Queryable, driverId: string, lock: boolean): Promise<boolean | null> {
  const rows = await q.query<{ money_armed: boolean }>(
    `SELECT money_armed FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${
      lock ? " FOR UPDATE" : ""
    }`,
    [driverId],
  );
  return rows.length === 1 ? rows[0].money_armed === true : null;
}

async function lockLoad(q: Queryable, loadId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE",
    [loadId],
  );
  return rows.length === 1;
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

async function issueRows(q: Queryable, codeId: string): Promise<MoneyAction[]> {
  return (await readBySubject(q, "money_codes", codeId)).filter((a) => a.kind === "money_code_issue");
}

// A money_code proposal that ends without a code, with a note code the record says in words. Only
// from approved or executing, the two states the proposal guard lets move to failed.
function failProposal(q: Queryable, proposalId: string, note: string, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'money_code'
        AND status IN ('approved', 'executing')`,
    [proposalId, note.slice(0, NOTE_MAX), nowIso],
  );
}

// ---- The ledger hooks ----

// The issuer's request for a code, built from the stored code row and the ledger row only.
function requestOf(action: MoneyAction, purpose: MoneyCodePurpose): MoneyCodeRequest {
  return {
    actionId: action.id,
    driverId: action.counterpartyId,
    amountCents: action.amountCents,
    memoCode: memoCodeOf(action),
    purpose,
  };
}

// In the reserve transaction: the code names its ledger row, and the proposal records its first.
// The code must still be one a send may start from; a throw rolls the reservation back.
async function onCodeReserved(q: Queryable, action: MoneyAction): Promise<void> {
  const changed = await q.execute(
    `UPDATE money_codes SET money_action_id = CAST($2 AS uuid), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('issuing', 'unknown')`,
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

const PROVIDER_REF = /^fcs_code_[0-9a-f]{24}$/;
const LAST4 = /^[0-9]{4}$/;

export const chargeItemRef = (codeId: string) => `money_code:${codeId}:charge`;
export const reimbursementItemRef = (codeId: string) => `money_code:${codeId}:reimbursement`;

const REIMBURSEMENT_WORDS: Readonly<Record<MoneyCodePurpose, string>> = {
  lumper: "Lumper receipt, paid with a money code",
  repair: "Repair receipt, paid with a money code",
  other: "Receipt paid with a money code",
};

async function payItemId(q: Queryable, itemRef: string): Promise<string> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM pay_items WHERE tenant_id = current_tenant_id() AND item_ref = $1",
    [itemRef],
  );
  if (rows.length !== 1) throw new MoneyError("validation");
  return rows[0].id;
}

// The post-confirm step, in the settle transaction (the executor's or the reconcile pass's).
// Idempotent: the code row is locked first, an issued code is left as it is (only its proposal
// is closed), and the pay items are keyed by item_ref, so a confirm read back twice writes once.
// A code no longer issuing or unknown (called off while the code went out) throws, so the ledger
// row stays open for a person. nowIso is the caller's clock, the issue time when the ledger row
// carries no settle time.
export async function finishIssuedCode(
  q: Queryable,
  action: MoneyAction,
  issuer: MoneyCodeIssuer,
  nowIso: string,
): Promise<void> {
  if (action.kind !== "money_code_issue" || action.state !== "confirmed") throw new MoneyError("validation");
  const code = await codeBy(q, "id", action.subjectId, true);
  if (!code || code.driverId !== action.counterpartyId || code.amountCents !== action.amountCents) {
    throw new MoneyError("validation");
  }
  const closeProposal = async () => {
    if (!action.proposalId) return;
    await q.execute(
      `UPDATE proposals SET status = 'done', updated_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [action.proposalId],
    );
  };
  if (code.status === "issued") {
    await closeProposal();
    return;
  }
  if (code.status !== "issuing" && code.status !== "unknown") throw new MoneyError("validation");
  const providerRef = action.outsideId;
  if (typeof providerRef !== "string" || !PROVIDER_REF.test(providerRef)) throw new MoneyError("validation");
  const last4 = issuer.codeLast4(action.requestId);
  if (!LAST4.test(last4)) throw new MoneyError("validation");
  if (!(await lockLoad(q, code.loadId))) throw new MoneyError("validation");
  const zone = await readTenantZone(q);
  const issuedAt = action.settledAt ?? nowIso;
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) throw new MoneyError("validation");
  const expiresAt = new Date(issuedMs + CODE_LIFETIME_MS).toISOString();
  const itemDate = localDateOf(issuedAt, zone);

  let accessorialId: string | null = null;
  if (code.purpose === "lumper") {
    // Under the load lock, so two codes on one load never take the same seq.
    const seqs = await q.query<{ next: number | string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM load_accessorials
        WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) AND kind = 'lumper'`,
      [code.loadId],
    );
    accessorialId = randomUUID();
    await q.execute(
      `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, paid_by_driver, description)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'lumper', $3, $4, true, $5)`,
      [accessorialId, code.loadId, Number(seqs[0]?.next ?? 1), code.amountCents, `Lumper, money code ${last4}`],
    );
  }
  await q.execute(
    `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, ref_table, ref_id,
                            item_ref, description)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'other_deduction', 'money_code', $2,
             CAST($3 AS date), 'loads', CAST($4 AS uuid), $5, $6)
     ON CONFLICT (tenant_id, item_ref) DO NOTHING`,
    [code.driverId, code.amountCents, itemDate, code.loadId, chargeItemRef(code.id), `Money code ${last4}`],
  );
  await q.execute(
    `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, ref_table, ref_id,
                            item_ref, description)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'reimbursement', $2, $3,
             CAST($4 AS date), $5, CAST($6 AS uuid), $7, $8)
     ON CONFLICT (tenant_id, item_ref) DO NOTHING`,
    [
      code.driverId,
      code.purpose,
      code.amountCents,
      itemDate,
      accessorialId ? "load_accessorials" : "loads",
      accessorialId ?? code.loadId,
      reimbursementItemRef(code.id),
      REIMBURSEMENT_WORDS[code.purpose],
    ],
  );
  const changed = await q.execute(
    `UPDATE money_codes
        SET status = 'issued', provider_ref = $2, code_last4 = $3, issued_at = CAST($4 AS timestamptz),
            expires_at = CAST($5 AS timestamptz), accessorial_id = CAST($6 AS uuid),
            charge_item_id = CAST($7 AS uuid), reimbursement_item_id = CAST($8 AS uuid),
            money_action_id = COALESCE(money_action_id, CAST($9 AS uuid)), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('issuing', 'unknown')`,
    [
      code.id,
      providerRef,
      last4,
      issuedAt,
      expiresAt,
      accessorialId,
      await payItemId(q, chargeItemRef(code.id)),
      await payItemId(q, reimbursementItemRef(code.id)),
      action.id,
    ],
  );
  if (changed !== 1) throw new MoneyError("validation");
  await closeProposal();
}

// A definite failure: no code was issued. The code ends failed and so does its proposal, stamped
// with the caller's clock.
async function onCodeFailed(q: Queryable, action: MoneyAction, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE money_codes SET status = 'failed', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('issuing', 'unknown')`,
    [action.subjectId],
  );
  if (action.proposalId) {
    await failProposal(q, action.proposalId, `code_failed: ${action.failureCategory ?? "unknown"}`, nowIso);
  }
}

function sendHooks(issuer: MoneyCodeIssuer, purpose: MoneyCodePurpose, nowIso: string): MoneyHooks {
  return {
    onReserved: onCodeReserved,
    onConfirmed: (q, action) => finishIssuedCode(q, action, issuer, nowIso),
    onFailed: (q, action) => onCodeFailed(q, action, nowIso),
    ready: () => issuer.ready(),
    // The feature switch at the write, on top of the money executor's payoutsEnabled; the issuer
    // asks both again itself.
    send: async (action, ctx) => {
      if (!moneyCodesOn()) return { kind: "failed", category: "disabled" };
      return issuer.issueMoneyCode(requestOf(action, purpose), ctx);
    },
  };
}

export function codeReconcileHooks(issuer: MoneyCodeIssuer, purpose: MoneyCodePurpose, nowIso: string): ReconcileHooks {
  return {
    onConfirmed: (q, action) => finishIssuedCode(q, action, issuer, nowIso),
    onFailed: (q, action) => onCodeFailed(q, action, nowIso),
    ready: () => issuer.ready(),
    readBack: (action, ctx) =>
      issuer.readBackCode(
        { requestId: action.requestId, outsideId: action.outsideId, request: requestOf(action, purpose) },
        ctx,
      ),
  };
}

// ---- Approval ----

// The gate's early refusal (Precheck in src/lib/proposals/execute.ts), under the gate's proposal
// lock before the proposal becomes approved: a refusal leaves it waiting, with nothing written.
// Reads only. The executor asks all of it again after the approval. For the autopilot (ctx.opts
// .autopilot) the rules engine must also allow exactly the proposal's amount now: a code whose
// numbers moved is refused here as stale_eligibility (the advance precheck's word) and waits for a
// person, never approved only to be refused after.
export async function precheckMoneyCode(
  q: Queryable,
  p: ProposalRow,
  now: Date,
  ctx?: PrecheckContext,
): Promise<ProposalRefused | null> {
  if (!moneyCodesOn()) return no("codes_off");
  const a = codeArgsOf(p);
  if (!a) return no("not_executable");
  const nowIso = now.toISOString();
  const zone = await readTenantZone(q);
  const refusal = issueGate(a.amountCents, localDateOf(nowIso, zone));
  if (refusal) return no(refusal);
  const armed = await driverArmed(q, a.driverId, false);
  if (armed === null) return no("not_found");
  if (await codeBy(q, "proposal_id", p.id, false)) return no("code_exists");
  let decision: MoneyCodeDecision;
  try {
    decision = await checkNow(q, a, nowIso);
  } catch {
    return no("check_unavailable", true);
  }
  if (!decision.ok) return no(decision.category);
  if (ctx?.opts.autopilot !== undefined && decision.amountCents !== a.amountCents) return no("stale_eligibility");
  return null;
}

type Prepared =
  | { kind: "issue"; code: CodeLock; attempt: number }
  | { kind: "done"; code: CodeLock; moneyActionId: string | null }
  | { kind: "refused"; category: string }
  | { kind: "failed"; category: string };

async function prepare(
  q: Queryable,
  session: Session,
  p: ProposalRow,
  a: CodeArgs,
  now: Date,
  newId: () => string,
): Promise<Prepared> {
  const locked = await q.query<{ status: string }>(
    `SELECT status FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'money_code'
      FOR UPDATE`,
    [p.id],
  );
  if (locked.length !== 1) throw new Stop("not_found");
  const status = locked[0].status;
  if (status === "proposed") throw new Stop("not_executable");
  if (status !== "approved" && status !== "executing") throw new Stop("already_decided");

  const nowIso = now.toISOString();
  const zone = await readTenantZone(q);
  const refusal = issueGate(a.amountCents, localDateOf(nowIso, zone));
  if (refusal) throw new Stop(refusal);
  // A resume (the proposal executing, its code already written) writes no code, so it takes
  // neither the driver nor the load lock. The settle transaction locks the code, then the load,
  // then the driver (the paystub lines' key) and then the proposal; this one holds the proposal,
  // so waiting on the driver or the load here would close a cycle with a settle in flight, and
  // the database would abort one of them. The arming is still read, so a resume never sends for
  // a driver disarmed since.
  const existing = status === "executing" ? await codeBy(q, "proposal_id", p.id, false) : null;
  const resume = existing !== null;
  // On a new code, arming takes the driver lock, so it cannot change between this read and the
  // commit that writes the code.
  const armed = await driverArmed(q, a.driverId, !resume);
  if (armed === null) throw new Stop("not_found");
  if (!armed) throw new Stop("driver_not_armed");
  if (!resume && !(await lockLoad(q, a.loadId))) throw new Stop("not_found");

  // The code row is read, never locked, here. The reserve, settle and close transactions lock the
  // code first and then the load or the proposal; this one already holds the proposal (and, for
  // a new code, the load), so waiting on the code here would close a cycle (a second approval
  // pressed while the first reserves). The proposal lock already serializes approvals, and the
  // reserve locks the code itself and asks its status again.
  let code = resume ? existing : await codeBy(q, "proposal_id", p.id, false);
  if (!code) {
    let decision: MoneyCodeDecision;
    try {
      decision = await checkNow(q, a, nowIso);
    } catch {
      throw new Stop("check_unavailable", true);
    }
    if (!decision.ok || decision.amountCents !== a.amountCents) {
      // The facts changed since the proposal: no code. Written and returned (the commit keeps it),
      // so the card and the record say why.
      const category = decision.ok ? "amount_invalid" : decision.category;
      await failProposal(q, p.id, `refused: ${category}`, nowIso);
      return { kind: "refused", category };
    }
    const receiptTotal =
      a.source === "document" ? a.amountCents : null; // checkMoneyCode allowed it only when equal
    await q.execute(
      `INSERT INTO money_codes (id, tenant_id, driver_id, load_id, purpose, amount_cents, source_kind, document_id,
                                voice_note_id, receipt_total_cents, proposal_id, membership_id, status,
                                created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, $6,
               CAST($7 AS uuid), CAST($8 AS uuid), $9, CAST($10 AS uuid), CAST($11 AS uuid), 'issuing',
               CAST($12 AS timestamptz), CAST($12 AS timestamptz))
       ON CONFLICT (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL DO NOTHING`,
      [
        newId(),
        a.driverId,
        a.loadId,
        a.purpose,
        a.amountCents,
        a.source,
        a.documentId,
        a.voiceNoteId,
        receiptTotal,
        p.id,
        await memberId(q, session),
        // The approval's instant, the same clock the rules engine counted the day and window by.
        nowIso,
      ],
    );
    code = await codeBy(q, "proposal_id", p.id, false);
    if (!code) throw new DbError("unknown");
  }
  if (code.driverId !== a.driverId || code.loadId !== a.loadId || code.amountCents !== a.amountCents) {
    throw new Stop("not_executable");
  }
  if (status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  const rows = await issueRows(q, code.id);
  const latest = rows.at(-1) ?? null;
  if (code.status === "issued") return { kind: "done", code, moneyActionId: latest?.id ?? null };
  if (code.status === "voided") throw new Stop("already_decided");
  if (code.status === "failed" || latest?.state === "failed") {
    if (latest) await onCodeFailed(q, latest, nowIso);
    else await failProposal(q, p.id, "code_failed", nowIso);
    return { kind: "failed", category: latest?.failureCategory === "declined" ? "code_declined" : "code_failed" };
  }
  return { kind: "issue", code, attempt: latest ? latest.attempt : 1 };
}

// After a refusal before any ledger row was reserved (the switch went off, the issuer was not
// ready): the code ends failed and so does its proposal, so nothing is left issuing with no row.
// Only while the code has no ledger row: a row reserved by another approval in the meantime keeps
// the code for the reconcile pass.
async function abandonUnsent(
  db: TenantDb,
  session: Session,
  codeId: string,
  proposalId: string,
  category: string,
  nowIso: string,
): Promise<void> {
  try {
    await db.withTenant(session.tenantId, async (q) => {
      const code = await codeBy(q, "id", codeId, true);
      if (!code || code.status !== "issuing") return;
      if ((await issueRows(q, codeId)).length > 0) return;
      await q.execute(
        `UPDATE money_codes SET status = 'failed', updated_at = now()
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'
            AND money_action_id IS NULL`,
        [codeId],
      );
      await failProposal(q, proposalId, `not_sent: ${category}`, nowIso);
    });
  } catch (err) {
    console.error("money code could not be closed:", err instanceof Error ? err.name : "unknown");
  }
}

// An issue whose outcome is not known yet reads as unknown on the code until Check pending.
async function markUnknown(db: TenantDb, session: Session, codeId: string): Promise<void> {
  try {
    await db.withTenant(session.tenantId, (q) =>
      q.execute(
        `UPDATE money_codes SET status = 'unknown', updated_at = now()
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'issuing'`,
        [codeId],
      ),
    );
  } catch (err) {
    console.error("money code status could not be written:", err instanceof Error ? err.name : "unknown");
  }
}

const GATE_OF_MONEY: Readonly<Record<string, string>> = { disabled: "codes_off" };

type Issued =
  | { ok: true; state: "confirmed" | "pending"; actionId: string }
  | { ok: false; category: string; retryable: boolean };

async function issue(
  db: TenantDb,
  session: Session,
  code: CodeLock,
  attempt: number,
  proposal: ProposalRow,
  deps: MoneyCodeDeps,
): Promise<Issued> {
  const nowIso = nowOf(deps).toISOString();
  // The issue gate once more, right before the money executor: the executor itself re-checks
  // only payoutsEnabled and the issuer. A refusal here is a definite no with nothing reserved.
  let refusal: string | null;
  try {
    const zone = await db.withTenant(session.tenantId, (q) => readTenantZone(q));
    refusal = issueGate(code.amountCents, localDateOf(nowIso, zone));
  } catch (err) {
    console.error("money code gate could not be read:", err instanceof Error ? err.name : "unknown");
    return no("code_unavailable", true);
  }
  if (refusal) {
    if (code.proposalId) await abandonUnsent(db, session, code.id, code.proposalId, refusal, nowIso);
    return no(refusal);
  }
  const issuer = deps.issuer ?? moneyCodeIssuer();
  try {
    const r = await executeMoneyAction(
      db,
      session,
      {
        kind: "money_code_issue",
        subjectId: code.id,
        counterpartyId: code.driverId,
        amountCents: code.amountCents,
        attempt,
        // A chat proposal is the agent's; a request from the form (no conversation) is a person's.
        proposedBy: proposal.conversationId === null ? "person" : "agent",
        proposalId: code.proposalId,
        traceId: isCanonicalUuid(proposal.traceId) ? proposal.traceId : null,
        subjectStatuses: ["issuing", "unknown"],
      },
      sendHooks(issuer, code.purpose, nowIso),
      deps.money,
    );
    if (r.action.state === "confirmed") return { ok: true, state: "confirmed", actionId: r.action.id };
    if (r.action.state === "failed") {
      const c = r.action.failureCategory;
      return no(c === "declined" ? "code_declined" : c === "disabled" ? "codes_off" : "code_unavailable");
    }
    if (r.action.state === "unknown" || r.action.state === "sent") await markUnknown(db, session, code.id);
    return { ok: true, state: "pending", actionId: r.action.id };
  } catch (err) {
    if (err instanceof MoneyError) {
      // Thrown before a row was reserved (a switch off, the issuer not ready, a bad draft):
      // nothing went out. "unknown" is the one exception: the send happened and even the read of
      // its row failed, so it stays pending for Check pending.
      if (err.category === "unknown") return no("code_pending");
      if (code.proposalId) await abandonUnsent(db, session, code.id, code.proposalId, err.category, nowIso);
      return no(GATE_OF_MONEY[err.category] ?? "code_unavailable");
    }
    if (err instanceof ForbiddenError) throw err;
    console.error("money code issue did not finish:", err instanceof Error ? err.name : "unknown");
    // Not always before a send: money may have moved. Unknown, never a retry.
    return no("code_pending");
  }
}

// The two live-evidence indexes (0048): breaking one means the same document or voice note
// already backs a live code. Matched on the whole constraint name the driver reports (pg's own
// field, or the quoted name the Data API's text gives), never a part of it. Any other unique
// violation, or one with no name, stays code_ref_collision. Either way the transaction rolled
// back, so nothing was written.
const EVIDENCE_INDEXES: ReadonlySet<string> = new Set([
  "money_codes_one_live_per_document",
  "money_codes_one_live_per_voice_note",
]);

export function uniqueViolationCategory(constraint: string | undefined): "evidence_reused" | "code_ref_collision" {
  return constraint !== undefined && EVIDENCE_INDEXES.has(constraint) ? "evidence_reused" : "code_ref_collision";
}

export const executeMoneyCodeProposal: Executor = async (
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: MoneyCodeDeps,
): Promise<ProposalResult> => {
  if (!moneyCodesOn()) return no("codes_off");
  const a = codeArgsOf(proposal);
  if (!a) return no("not_executable");
  const now = nowOf(deps);
  const newId = deps.newId ?? randomUUID;
  let prepared: Prepared;
  try {
    prepared = await db.withTenant(session.tenantId, (q) => prepare(q, session, proposal, a, now, newId));
  } catch (err) {
    if (err instanceof Stop) return err.result;
    if (err instanceof DbError && err.sqlState === "23505") return no(uniqueViolationCategory(err.constraint));
    throw err;
  }
  if (prepared.kind === "refused") return no(prepared.category);
  if (prepared.kind === "failed") return no(prepared.category);
  if (prepared.kind === "done") {
    return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: prepared.moneyActionId };
  }
  const issued = await issue(db, session, prepared.code, prepared.attempt, proposal, deps);
  if (!issued.ok) return issued;
  return {
    ok: true,
    proposalId: proposal.id,
    status: issued.state === "confirmed" ? "done" : "executing",
    moneyActionId: issued.actionId,
  };
};

export const moneyCodeExecutor: Executor = Object.assign(
  (...args: Parameters<Executor>) => executeMoneyCodeProposal(...args),
  { precheck: precheckMoneyCode },
);

// ---- Check pending and reveal ----

// The reconcile pass reads back a row still sent only once it is this old (an unknown row at
// once), so a send still in flight is not read back as if it had been lost.
const CHECK_AFTER_SECONDS = 60;

export type CheckResult =
  | { ok: true; summary: ReconcileSummary; tooNew: number; stillWaiting: number }
  | { ok: false; category: string; retryable: boolean };

// Check pending: the reconcile pass over this code's own open ledger rows, each read back by its
// request id. Never issues anything new; a code found issued gets the same finishIssuedCode the
// approval would have run. A person asked, so the read-back runs even past the automatic check
// limit; it stays read-only toward the provider.
export async function checkPendingCode(
  session: Session,
  codeId: string,
  deps: MoneyCodeDeps = {},
): Promise<CheckResult> {
  if (!moneyCodesOn()) return no("codes_off");
  const db = deps.db ?? getDb();
  const nowIso = nowOf(deps).toISOString();
  const found = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return codeBy(q, "id", codeId, false);
  });
  if (!found) return no("not_found");
  const issuer = deps.issuer ?? moneyCodeIssuer();
  const summary = await reconcileMoneyActions(
    db,
    session,
    {
      hooks: { money_code_issue: codeReconcileHooks(issuer, found.purpose, nowIso) },
      limit: 5,
      olderThanSeconds: CHECK_AFTER_SECONDS,
      subject: { table: "money_codes", id: found.id },
      ignoreCheckLimit: true,
    },
    deps.money,
  );
  let tooNew = 0;
  let stillWaiting = 0;
  if (summary.checked === 0) {
    const rows = await db.withTenant(session.tenantId, (q) => issueRows(q, found.id));
    for (const r of rows) {
      if (r.state === "sent" && r.sentSecondsAgo !== null && r.sentSecondsAgo <= CHECK_AFTER_SECONDS) tooNew += 1;
      else if (r.state === "sent" || r.state === "unknown") stillWaiting += 1;
    }
  }
  return { ok: true, summary, tooNew, stillWaiting };
}

export type RevealResult =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; category: string; retryable: boolean };

// The ten digits of an issued code, for staff to read to the driver. Any member of this carrier
// (admin or staff) may ask; each ask is logged with who and when, never the code. Refused while
// money codes are off, before the code is issued, and after it expires.
export async function revealMoneyCode(session: Session, codeId: string, deps: MoneyCodeDeps = {}): Promise<RevealResult> {
  if (!moneyCodesOn()) return no("codes_off");
  const db = deps.db ?? getDb();
  const now = nowOf(deps);
  const picked = await db.withTenant(session.tenantId, async (q) => {
    const member = await memberId(q, session);
    const rows = await q.query<{ status: string; expires_at: string | null }>(
      `SELECT status, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
         FROM money_codes WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [codeId],
    );
    if (rows.length !== 1) return { member, state: "not_found" as const };
    const r = rows[0];
    if (r.status !== "issued" || r.expires_at === null) return { member, state: "not_issued" as const };
    if (Date.parse(r.expires_at) <= now.getTime()) return { member, state: "code_expired" as const };
    const confirmed = (await issueRows(q, codeId)).filter((a) => a.state === "confirmed");
    if (confirmed.length !== 1) return { member, state: "not_issued" as const };
    return { member, state: "ok" as const, requestId: confirmed[0].requestId, expiresAt: r.expires_at };
  });
  if (picked.state !== "ok") return no(picked.state);
  const issuer = deps.issuer ?? moneyCodeIssuer();
  let code: string;
  try {
    code = issuer.revealCode(picked.requestId);
  } catch (err) {
    if (err instanceof MoneyError && err.category === "disabled") return no("codes_off");
    return no("code_unavailable", true);
  }
  console.info(`money codes: code ${codeId} shown to membership ${picked.member} at ${now.toISOString()}`);
  return { ok: true, code, expiresAt: picked.expiresAt };
}
