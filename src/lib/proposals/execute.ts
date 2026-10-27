import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { overrideReasonOf } from "../agent/auditor/words";
import { executeDetentionCharge } from "./executors/detention-charge";

// A person approves an agent's proposal (design 2.8). This file is outside src/lib/agent on
// purpose: approval is the only road from a proposal to the ledger, and the agent tree cannot
// import it (the import-boundary test).
//
// Every approval passes the same gate first, in one tenant transaction with the proposal locked:
// it exists, it is still waiting (or approved/executing, which is a resume), it is not past
// proposalMaxAgeDays (an old one becomes expired, here, with no scheduled job), the member's role
// covers the amount (approverRole), the auditor's verdict is in when auditorRequired is on (one
// made before auditorStart, which the auditor never checks, is refused as not_auditable rather
// than left waiting), a block carries the person's override reason for the very verdict they saw,
// and anything other than a pass, or anything flagged, carries the person's second confirm. Then
// the proposal's kind picks its executor from EXECUTORS. A kind with no executor is refused as
// not_executable before any write. Every refusal except expired leaves the row proposed and writes
// nothing. When every check passes, the gate moves the proposal to approved in that same locked
// transaction (a block's override reason, with who and when, goes in the same statement), so a
// reject that lands after the gate finds it approved and is refused; only then does the executor
// run. Each executor reserves its ledger row before any outside call (the money executor) and
// moves the proposal on from there.

export const PROPOSAL_KINDS = [
  "advance_payout",
  "pay_correction",
  "invoice_fix",
  "detention_charge",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type ProposalRow = {
  id: string;
  conversationId: string;
  turnId: string;
  kind: ProposalKind;
  subjectTable: string;
  subjectId: string;
  amountCents: number;
  direction: "in" | "out" | "none";
  args: Record<string, unknown>;
  status: string;
  flaggedInputId: string | null;
  auditorVerdict: string | null;
  auditorAgrees: boolean | null;
  moneyActionId: string | null;
  traceId: string;
};

// confirmed: the person's second confirm, on a flagged proposal (owner decision 2) or on any
// auditor verdict other than pass. overrideReason: their reason for approving over a block (the
// gate trims it and checks its length again). auditedAt: the auditor's checked_at the card showed,
// so an override always refers to the one verdict the person read.
export type ApproveOptions = {
  confirmed: boolean;
  overrideReason?: string | null;
  auditedAt?: string | null;
};

export type ProposalRefusal =
  | "not_found"
  | "not_executable"
  | "already_decided"
  | "expired"
  | "role"
  | "auditor_required"
  | "not_auditable"
  | "override_required"
  | "stale"
  | "needs_confirm";

export type ProposalResult =
  | { ok: true; proposalId: string; status: string; moneyActionId: string | null }
  | { ok: false; category: ProposalRefusal | (string & {}); retryable: boolean };

export type ExecuteDeps = {
  db?: TenantDb;
  clock?: () => Date;
  // Tests swap the registry; production uses EXECUTORS.
  executors?: ExecutorRegistry;
};

// An executor's contract: it runs only on a row the gate already moved to approved (or one already
// executing, on a resume), never on a proposed one, and it never sets approved itself. On a resume
// it must re-read its own ledger row (the ledger's reserve replays the same request by its
// idempotency key) before doing any work. A crash inside an executor leaves the proposal approved with a null money_action_id; the
// next approve takes the resume path below and runs the executor again. That resume path
// deliberately skips the expiry, role, auditor and confirm checks: they all passed when the row
// became approved, under the same lock, and the person's approval stands.
export type Executor = (
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  opts: ApproveOptions,
  deps: ExecuteDeps,
) => Promise<ProposalResult>;

export type ExecutorRegistry = Readonly<Partial<Record<ProposalKind, Executor>>>;

// One executor per kind. advance_payout comes with ADVANCES (it creates the advances row the
// ledger needs at approval); pay_correction and invoice_fix have none yet. detention_charge is
// read through its release switch on every approval: with detentionEnabled off the kind has no
// executor, so a detention_charge can be neither approved nor executed. On a resume (a row already
// approved or executing), gate refuses it as not_executable before the executor runs. Otherwise
// that refusal is gate's last check before the approve write, and every earlier outcome comes
// first: the membership check, not_found, already_decided, expiring an aged proposal (which writes
// the row as expired), the role refusal, the auditor refusals (not_auditable, auditor_required,
// override_required, stale) and needs_confirm.
export const EXECUTORS: ExecutorRegistry = {
  get detention_charge() {
    return flags.detentionEnabled ? executeDetentionCharge : undefined;
  },
};

const DAY_MS = 86_400_000;

// auditorStart as an instant, or null when it does not read as one. Null counts every proposal as
// made before it: the auditor itself never checks a proposal against an unreadable start.
function auditorStartIso(): string | null {
  const start = Date.parse(flags.auditorStart);
  return Number.isFinite(start) ? new Date(start).toISOString() : null;
}

type Row = {
  id: string;
  conversation_id: string;
  turn_id: string;
  kind: ProposalKind;
  subject_table: string;
  subject_id: string;
  amount_cents: number | string;
  direction: ProposalRow["direction"];
  args: string;
  status: string;
  flagged_input_id: string | null;
  auditor_verdict: string | null;
  auditor_agrees: boolean | null;
  money_action_id: string | null;
  trace_id: string;
  too_old: boolean;
  before_auditor: boolean;
  auditor_checked_at: string | null;
};

function rowOf(r: Row): ProposalRow {
  let args: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(r.args);
    if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
  } catch {
    // stays empty; the executor re-validates what it needs
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    turnId: r.turn_id,
    kind: r.kind,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    amountCents: Number(r.amount_cents),
    direction: r.direction,
    args,
    status: r.status,
    flaggedInputId: r.flagged_input_id,
    auditorVerdict: r.auditor_verdict,
    auditorAgrees: r.auditor_agrees,
    moneyActionId: r.money_action_id,
    traceId: r.trace_id,
  };
}

function executorFor(registry: ExecutorRegistry, kind: string): Executor | null {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) return null;
  if (!Object.prototype.hasOwnProperty.call(registry, kind)) return null;
  return registry[kind as ProposalKind] ?? null;
}

const refused = (category: ProposalRefusal): ProposalResult => ({ ok: false, category, retryable: false });

type Gate = { run: ProposalRow; executor: Executor } | { result: ProposalResult };

async function gate(
  q: Queryable,
  session: Session,
  proposalId: string,
  opts: ApproveOptions,
  now: Date,
  registry: ExecutorRegistry,
): Promise<Gate> {
  await assertMembership(q, session);
  const member = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE cognito_sub = $1",
    [session.sub],
  );
  const cutoff = new Date(now.getTime() - flags.proposalMaxAgeDays * DAY_MS).toISOString();
  const rows = await q.query<Row>(
    `SELECT id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents, direction,
            CAST(args AS text) AS args, status, flagged_input_id, auditor_verdict, auditor_agrees,
            money_action_id, trace_id, (created_at < CAST($2 AS timestamptz)) AS too_old,
            (CAST($3 AS timestamptz) IS NULL OR created_at < CAST($3 AS timestamptz)) AS before_auditor,
            to_char(auditor_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS auditor_checked_at
       FROM proposals WHERE id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId, cutoff, auditorStartIso()],
  );
  if (rows.length !== 1) return { result: refused("not_found") };
  const p = rowOf(rows[0]);
  const executor = executorFor(registry, p.kind);
  // A resume: every check passed when the row became approved, so none is run again here (see the
  // Executor contract); the executor reads its ledger row back.
  if (p.status === "approved" || p.status === "executing") {
    return executor ? { run: p, executor } : { result: refused("not_executable") };
  }
  if (p.status !== "proposed") return { result: refused("already_decided") };
  if (rows[0].too_old) {
    await q.execute(
      `UPDATE proposals
          SET status = 'expired', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              decision_note = 'expired', updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
      [p.id, session.sub, now.toISOString()],
    );
    return { result: refused("expired") };
  }
  if (p.amountCents > flags.approverRole.adminAboveCents && member[0]?.role !== "admin") {
    return { result: refused("role") };
  }
  // The auditor never checks a proposal made before auditorStart, so that one would wait for good:
  // it is refused as not auditable instead.
  if (flags.auditorRequired && p.auditorVerdict === null) {
    return { result: refused(rows[0].before_auditor ? "not_auditable" : "auditor_required") };
  }
  // A block needs a reason, checked again here, for the very verdict the card showed. A stored
  // override only ever sits on a row that is already approved or later, which took the resume path
  // above.
  const block = p.auditorVerdict === "block";
  const reason = block ? overrideReasonOf(opts.overrideReason) : null;
  if (block) {
    if (reason === null) return { result: refused("override_required") };
    if (!sameInstant(opts.auditedAt, rows[0].auditor_checked_at)) return { result: refused("stale") };
  }
  // Only a pass goes through on one click: every other verdict, and any flagged input, needs the
  // second confirm.
  const needsConfirm = p.flaggedInputId !== null || p.auditorVerdict !== "pass";
  if (needsConfirm && !opts.confirmed) return { result: refused("needs_confirm") };
  if (!executor) return { result: refused("not_executable") };
  // Lock the approval in while the row is still locked. Exactly one row must move; anything else
  // means it is no longer waiting, and nothing runs. A block's override is stored in the same
  // statement, only for the verdict the card showed and only if none is stored yet, so the
  // approval and its reason land together or not at all.
  const nowIso = now.toISOString();
  const approved =
    reason === null
      ? await q.execute(
          `UPDATE proposals
              SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                  updated_at = CAST($3 AS timestamptz)
            WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
          [p.id, session.sub, nowIso],
        )
      : await q.execute(
          `UPDATE proposals
              SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                  updated_at = CAST($3 AS timestamptz), auditor_override_reason = $4,
                  auditor_override_by = $2, auditor_override_at = CAST($3 AS timestamptz)
            WHERE id = CAST($1 AS uuid) AND status = 'proposed' AND auditor_verdict = 'block'
              AND auditor_override_reason IS NULL
              AND date_trunc('milliseconds', auditor_checked_at) = CAST($5 AS timestamptz)`,
          [p.id, session.sub, nowIso, reason, rows[0].auditor_checked_at],
        );
  if (approved !== 1) return { result: refused("already_decided") };
  // Never the reason itself: its length only.
  if (reason !== null) console.info(`proposal ${p.id} override=stored len=${reason.length}`);
  return { run: { ...p, status: "approved" }, executor };
}

// The instant the card showed equals the stored one, to the millisecond. Unknown is not equal.
function sameInstant(sent: string | null | undefined, stored: string | null): boolean {
  if (typeof sent !== "string" || stored === null) return false;
  const a = Date.parse(sent);
  const b = Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

export async function executeProposal(
  session: Session,
  proposalId: string,
  opts: ApproveOptions,
  deps: ExecuteDeps = {},
): Promise<ProposalResult> {
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const registry = deps.executors ?? EXECUTORS;
  const checked = await db.withTenant(session.tenantId, (q) =>
    gate(q, session, proposalId, opts, now, registry),
  );
  if ("result" in checked) return checked.result;
  return checked.executor(db, session, checked.run, opts, deps);
}
