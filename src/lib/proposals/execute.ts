import { flags } from "../../config/flags";
import { PROPOSAL_KINDS, type ProposalKind } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { executeAdvanceProposal, precheckAdvanceProposal } from "../advances/approve";
import { executeInvoicePost } from "../invoices/execute";
import { moneyCodeExecutor } from "../money-codes/execute";
import { executePaymentReapply } from "../invoices/reapply";
import { executeSettlementApprove } from "../settlements/approve";
import { assertMembership } from "../tenant/context";
import { decide, driverOf, isPaused, recordOf, type DecisionRecord } from "../autopilot/policy";
import { midnightMs, readDriverToday, readPause, readRule, readToday, readZone, todayStartIso } from "../autopilot/read";
import { autopilotSub, isAutopilotSub } from "../autopilot/session";
import { namedPersonRequired } from "../money/never-alone";
import { isServiceSub } from "../sweep/service-session";
import { isUuid } from "../uuid";
import { overrideReasonOf } from "../agent/auditor/words";
import { cardLoadRulingExecutor } from "./executors/card-load-ruling";
import { cardMatchExecutor } from "./executors/card-match";
import { factoringRequestExecutor } from "../factoring/execute";
import { executeBillDefer, executeChaseTestMode, executeFactoringTestMode } from "./executors/cash-friday";
import { escrowReleaseExecutor } from "./executors/escrow-release";
import { executeDetentionCharge } from "./executors/detention-charge";
import { loadCreateExecutor } from "./executors/load-create";
import { loadMoveExecutor } from "./executors/load-move";
import { loadRateFill } from "./executors/load-rate-fill";
import { payCorrectionExecutor } from "./executors/pay-correction";
import { payPolicySetupExecutor } from "./executors/pay-policy-setup";
import { executePayRuleChange } from "./executors/pay-rule-change";

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
// a mismatch with the rules engine's own recompute (engine_check, 0045) carries a reason too while
// verifyEngineMismatchBlocks is on, and anything other than a pass, or anything flagged, carries
// the person's second confirm. Then the proposal's kind picks its executor from EXECUTORS. A kind
// with no executor is refused as not_executable before any write. An executor with a precheck is
// asked it next, still under the lock: a refusal there returns with the proposal still waiting and
// nothing written. Every refusal except expired leaves the row proposed and writes nothing. When
// every check passes, the gate moves the proposal to approved in that same locked transaction (a
// block's or a mismatch's override reason, with who and when, goes in the same statement), so a
// reject that lands after the gate finds it approved and is refused; only then does the executor
// run. Each executor reserves its ledger row before any outside call (the money executor) and moves
// the proposal on from there.
//
// The carrier's autopilot login (src/lib/autopilot) is the one login that approves with no person:
// only with opts.autopilot naming the rule it was decided on, never with a confirm, an override
// reason, an audited instant or edits, never on a resume, never over a block or a held mismatch,
// and only when the policy (src/lib/autopilot/policy.ts) says auto again here, under the lock,
// with the switch, its arming and start date, the pause, the rule (locked, same id and version)
// and today's totals read inside this transaction, after every check above and before the
// precheck. Its approval stores the decision in the same statement. A kind a named person always
// approves (src/lib/money/never-alone.ts) is refused to the autopilot login as kind_never_alone
// the moment the row is read, before any write, even if a rule row for it slipped in. The sweep's
// login never approves, and opts.autopilot from any other login is refused.

export { PROPOSAL_KINDS, type ProposalKind };

export type ProposalRow = {
  id: string;
  // Null on a proposal the rules engine made outside a chat turn (origin 'engine', 0015).
  conversationId: string | null;
  turnId: string | null;
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
  traceId: string | null;
};

// confirmed: the person's second confirm, on a flagged proposal (owner decision 2) or on any
// auditor verdict other than pass. overrideReason: their reason for approving over a block or a
// held mismatch (the gate trims it and checks its length again; one reason covers both).
// auditedAt: the auditor's checked_at the card showed, so an override always refers to the one
// verdict the person read. edits: the person's own values for rules on a pay_policy_setup card
// (rule key to stored value text), or a card_load_ruling's ruling ({ ruling: "owes_nothing" });
// only those executors read them, check each whole, and take them only with confirmed. The gate stores them with the approval
// (approved_edits) and that executor plans from the stored copy only: a resume that sends other
// edits is refused, one that sends none uses the stored ones.
// autopilot: only the autopilot login sends it (src/lib/autopilot/run.ts), naming the rule and its
// version the policy decided on; no HTTP body can carry it (approve-body.ts reads a strict shape).
export type ApproveOptions = {
  confirmed: boolean;
  overrideReason?: string | null;
  auditedAt?: string | null;
  edits?: Readonly<Record<string, string>>;
  autopilot?: { ruleId: string; version: number };
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
  | "engine_override_required"
  | "stale"
  | "needs_confirm"
  | "service_login"
  | "autopilot_only"
  | "autopilot_override"
  | "autopilot_rule"
  | "kind_never_alone";

export type ProposalResult =
  | { ok: true; proposalId: string; status: string; moneyActionId: string | null }
  | { ok: false; category: ProposalRefusal | (string & {}); retryable: boolean };

export type ProposalRefused = Extract<ProposalResult, { ok: false }>;

export type ExecuteDeps = {
  db?: TenantDb;
  clock?: () => Date;
  // Tests swap the registry; production uses EXECUTORS.
  executors?: ExecutorRegistry;
};

// An executor's optional early refusal. The gate asks it inside its own transaction, with the
// proposal locked, after the gate's own checks pass and before it moves the proposal to approved.
// A refusal (or a throw) rolls that transaction back, so the proposal stays proposed, undecided,
// with its Approve button, and nothing is written. Reads only. It never replaces the executor's
// own checks: the executor asks them again after the approval, because a switch can change in
// between. It is not asked on a resume (the row is already approved). ctx: who is approving and
// what they sent, for a precheck that depends on it (pay_policy_setup's edits and role).
export type PrecheckContext = { session: Session; opts: ApproveOptions };
export type Precheck = (
  q: Queryable,
  proposal: ProposalRow,
  now: Date,
  ctx?: PrecheckContext,
) => Promise<ProposalRefused | null>;

// An executor's contract: it runs only on a row the gate already moved to approved (or one already
// executing, on a resume), never on a proposed one, and it never sets approved itself. On a resume
// it must re-read its own ledger row (the ledger's reserve replays the same request by its
// idempotency key) before doing any work. A crash inside an executor leaves the proposal approved with a null money_action_id; the
// next approve takes the resume path below and runs the executor again. That resume path
// deliberately skips the expiry, role, auditor and confirm checks: they all passed when the row
// became approved, under the same lock, and the person's approval stands.
export type Executor = {
  (
    db: TenantDb,
    session: Session,
    proposal: ProposalRow,
    opts: ApproveOptions,
    deps: ExecuteDeps,
  ): Promise<ProposalResult>;
  precheck?: Precheck;
};

export type ExecutorRegistry = Readonly<Partial<Record<ProposalKind, Executor>>>;

// One executor per kind. advance_payout creates the advances row at approval and pays it through
// the money executor (src/lib/advances/approve.ts), with a precheck that refuses before the
// approval when the payout could not run. load_rate_fill writes a load's missing rate and moves
// no money; invoice_post writes the approved invoice and payment_reapply moves one payment
// application. pay_correction writes one pay item for the next pay run
// (src/lib/proposals/executors/pay-correction.ts), with a precheck that refuses a stale fix before
// the approval. pay_rule_change writes one dated version of the pay rules
// (src/lib/proposals/executors/pay-rule-change.ts) and moves no money. invoice_fix has none yet,
// so it is refused as not_executable. detention_charge, pay_correction and pay_rule_change are
// read through their release switches on every approval: with detentionEnabled,
// payCorrectionsEnabled or rulesByTalkingEnabled off the kind has no executor, so it can be
// neither approved nor executed (and each executor checks its switch again itself). On a resume (a row already
// approved or executing), gate refuses it as not_executable before the executor runs. Otherwise
// that refusal is gate's last check before the approve write, and every earlier outcome comes
// first: the membership check, not_found, already_decided, expiring an aged proposal (which writes
// the row as expired), the role refusal, the auditor refusals (not_auditable, auditor_required,
// override_required, stale) and needs_confirm.
// settlement_approve pays one driver's week (src/lib/settlements/approve.ts); its own switch is
// read inside the executor, which writes nothing while it is off. card_match puts a card on a
// driver's file and records its purchase (src/lib/proposals/executors/card-match.ts), read through
// cardRecon.enabled like pay_correction, with a precheck that refuses a card no longer unknown.
// money_code issues one code (src/lib/money-codes/execute.ts), with a precheck that refuses before
// the approval when the code could not be issued now; it is read through moneyCodes.enabled the
// same way, and the executor asks the whole issue gate again itself. escrow_release sends a
// terminated driver's escrow balance back (src/lib/escrow/execute.ts), read through
// escrowRelease.enabled the same way.
export const EXECUTORS: ExecutorRegistry = {
  advance_payout: Object.assign(
    (...args: Parameters<Executor>) => executeAdvanceProposal(...args),
    { precheck: precheckAdvanceProposal },
  ),
  get pay_correction() {
    return flags.payCorrectionsEnabled ? payCorrectionExecutor : undefined;
  },
  load_rate_fill: loadRateFill,
  invoice_post: executeInvoicePost,
  payment_reapply: executePaymentReapply,
  get detention_charge() {
    return flags.detentionEnabled ? executeDetentionCharge : undefined;
  },
  settlement_approve: executeSettlementApprove,
  get card_match() {
    return flags.cardRecon.enabled ? cardMatchExecutor : undefined;
  },
  // Cash Friday (src/lib/proposals/executors/cash-friday.ts): a delayed bill moves one bill's
  // date; a chase is test mode and records the decision only. All three are read through
  // cashFridayEnabled on every approval, like detention_charge. A factoring card goes to the
  // simulated factoring partner (src/lib/factoring/execute.ts) while factoring.enabled is on, with
  // a precheck that refuses before the approval when it could not be sent; with factoring off it
  // keeps the test-mode record of the decision.
  get bill_defer() {
    return flags.cashFridayEnabled ? executeBillDefer : undefined;
  },
  get factoring_request() {
    if (flags.factoring?.enabled === true) return factoringRequestExecutor;
    return flags.cashFridayEnabled ? executeFactoringTestMode : undefined;
  },
  get collections_chase() {
    return flags.cashFridayEnabled ? executeChaseTestMode : undefined;
  },
  get pay_rule_change() {
    return flags.rulesByTalkingEnabled ? executePayRuleChange : undefined;
  },
  get money_code() {
    return flags.moneyCodes.enabled ? moneyCodeExecutor : undefined;
  },
  // Pay rules from a policy document (src/lib/proposals/executors/pay-policy-setup.ts): one new
  // dated version, read through policyOnboardEnabled on every approval, with a precheck that
  // refuses a card that still needs a choice, a bad edit, a start that no longer holds, or a
  // member whose role does not cover it, before anything is approved.
  get pay_policy_setup() {
    return flags.policyOnboardEnabled ? payPolicySetupExecutor : undefined;
  },
  // A load from a rate confirmation (src/lib/proposals/executors/load-create.ts): one planned load
  // with no driver, read through ratecon.enabled on every approval, with a precheck that refuses a
  // card whose reading, customer or number no longer checks before anything is approved.
  get load_create() {
    return flags.ratecon.enabled ? loadCreateExecutor : undefined;
  },
  // A terminated driver's escrow back to the driver (src/lib/escrow/execute.ts): one test-mode
  // bank payout of exactly the balance, read through escrowRelease.enabled on every approval, with
  // a precheck that refuses a driver still active, a balance that moved (stale), another live
  // release or any release gate reason before anything is approved.
  get escrow_release() {
    return flags.escrowRelease.enabled ? escrowReleaseExecutor : undefined;
  },
  // A load move code could not decide (src/lib/proposals/executors/load-move.ts): the one move the
  // card names, as the person's own press, read through loadMovement.enabled on every approval.
  // No money moves.
  get load_move() {
    return flags.loadMovement.enabled ? loadMoveExecutor : undefined;
  },
  // A named person's ruling on a card load with no payment record
  // (src/lib/proposals/executors/card-load-ruling.ts): a deficit for the full load as drafted, or
  // owes_nothing as the person's edit, read through cardLoadRuling.enabled on every approval, with
  // a precheck that refuses a machine login, a bad edit, an unconfirmed edit or a load that no
  // longer stands unexplained before anything is approved. No money moves.
  get card_load_ruling() {
    return flags.cardLoadRuling.enabled ? cardLoadRulingExecutor : undefined;
  },
};

const DAY_MS = 86_400_000;

// The kinds whose executor reads the person's own values: the gate stores them with the approval.
// A card load ruling's edit is the person's ruling (owes_nothing in place of the drafted deficit).
const EDITS_KINDS: ReadonlySet<string> = new Set<ProposalKind>(["pay_policy_setup", "card_load_ruling"]);

// auditorStart as an instant, or null when it does not read as one. Null counts every proposal as
// made before it: the auditor itself never checks a proposal against an unreadable start.
function auditorStartIso(): string | null {
  const start = Date.parse(flags.auditorStart);
  return Number.isFinite(start) ? new Date(start).toISOString() : null;
}

type Row = {
  id: string;
  conversation_id: string | null;
  turn_id: string | null;
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
  trace_id: string | null;
  too_old: boolean;
  before_auditor: boolean;
  auditor_checked_at: string | null;
  engine_check: string | null;
  created_at: string;
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

// Who is approving, before any proposal is read: the sweep's login never approves; the autopilot
// login only with opts.autopilot and nothing a person sends; opts.autopilot only from the
// carrier's own autopilot login, which must be staff. null means go on.
function principalRefusal(session: Session, opts: ApproveOptions, role: string | undefined): ProposalResult | null {
  if (isServiceSub(session.sub)) return refused("service_login");
  const auto = isAutopilotSub(session.sub);
  if (auto !== (opts.autopilot !== undefined)) return refused("autopilot_only");
  if (!auto) return null;
  if (session.sub !== autopilotSub(session.tenantId)) return refused("autopilot_only");
  if (
    opts.confirmed !== false ||
    (opts.overrideReason !== undefined && opts.overrideReason !== null) ||
    (opts.auditedAt !== undefined && opts.auditedAt !== null) ||
    opts.edits !== undefined
  ) {
    return refused("autopilot_override");
  }
  if (role !== "staff") return refused("role");
  const a = opts.autopilot;
  if (!a || !isUuid(a.ruleId) || !Number.isSafeInteger(a.version) || a.version < 1) return refused("autopilot_rule");
  return null;
}

// The autopilot's policy, decided again inside the gate's transaction with the proposal locked:
// the switch, its arming and start date read now, the pause, the rule (locked, so two approvals
// of one kind read today's totals one after the other) and today's totals, the driver's own too on a
// kind that pays a driver (a plain read: no driver or load lock is taken here). Anything but auto is
// refused with the policy's reason word and nothing written; a rule changed since the decision
// (another id or version) is refused too. Reads only.
async function autopilotDecision(
  q: Queryable,
  session: Session,
  p: ProposalRow,
  row: Row,
  sent: { ruleId: string; version: number },
  now: Date,
): Promise<{ record: DecisionRecord } | { result: ProposalResult }> {
  const pause = await readPause(q);
  const zone = await readZone(q);
  const rule = await readRule(q, p.kind, true);
  const since = todayStartIso(now, zone);
  const today = await readToday(q, p.kind, session.sub, since);
  const driverId = driverOf(p.kind, p);
  const driverToday = driverId === null ? null : await readDriverToday(q, p.kind, session.sub, since, driverId);
  const sw = flags.autopilot;
  const decided = decide({
    switch: { enabled: sw.enabled, armed: sw.armed, kinds: sw.kinds },
    paused: isPaused(pause, now.getTime()),
    startMs: midnightMs(sw.startDate, zone),
    rule,
    proposal: {
      kind: p.kind,
      driverId,
      status: p.status,
      amountCents: p.amountCents,
      createdAtMs: Date.parse(row.created_at),
      flagged: p.flaggedInputId !== null,
      auditorVerdict: p.auditorVerdict,
      engineCheck: row.engine_check,
    },
    today,
    driverToday,
  });
  if (decided.decision !== "auto") return { result: { ok: false, category: decided.reason, retryable: false } };
  if (!rule || rule.id !== sent.ruleId.toLowerCase() || rule.version !== sent.version) {
    return { result: refused("autopilot_rule") };
  }
  return { record: recordOf({ ...decided, decision: "auto" }, rule, today, { id: driverId, today: driverToday }) };
}

// A precheck's refusal, thrown out of the gate so its transaction rolls back (a read inside the
// precheck may have failed and left that transaction unusable). Nothing was written before it.
class Prechecked extends Error {
  readonly result: ProposalRefused;
  constructor(result: ProposalRefused) {
    super("proposal: refused by its precheck");
    this.name = "Prechecked";
    this.result = result;
  }
}

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
  const principal = principalRefusal(session, opts, member.length === 1 ? member[0].role : undefined);
  if (principal) return { result: principal };
  const auto = opts.autopilot !== undefined;
  const cutoff = new Date(now.getTime() - flags.proposalMaxAgeDays * DAY_MS).toISOString();
  const rows = await q.query<Row>(
    `SELECT id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents, direction,
            CAST(args AS text) AS args, status, flagged_input_id, auditor_verdict, auditor_agrees,
            money_action_id, trace_id, (created_at < CAST($2 AS timestamptz)) AS too_old,
            (CAST($3 AS timestamptz) IS NULL OR created_at < CAST($3 AS timestamptz)) AS before_auditor,
            to_char(auditor_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS auditor_checked_at, engine_check,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM proposals WHERE id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId, cutoff, auditorStartIso()],
  );
  if (rows.length !== 1) return { result: refused("not_found") };
  const p = rowOf(rows[0]);
  // Never the autopilot's: a named person approves this kind (an unknown kind too).
  if (auto && namedPersonRequired(p.kind)) return { result: refused("kind_never_alone") };
  const executor = executorFor(registry, p.kind);
  // A resume: every check passed when the row became approved, so none is run again here (see the
  // Executor contract); the executor reads its ledger row back.
  // The autopilot never resumes: an approval whose outcome it did not see is a person's to carry on.
  if (p.status === "approved" || p.status === "executing") {
    if (auto) return { result: refused("already_decided") };
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
  // A mismatch is held the same way while the switch is on (it is read here, on every approval).
  // The check never changes once stored, so the reason always refers to the mismatch the card
  // showed; an unchecked or unavailable one is not held (it is never Verified either).
  const mismatch = flags.verifyEngineMismatchBlocks && rows[0].engine_check === "mismatch";
  // The autopilot never carries an override: a block or any mismatch is refused outright.
  if (auto && block) return { result: refused("override_required") };
  if (auto && rows[0].engine_check === "mismatch") return { result: refused("engine_override_required") };
  const reason = block || mismatch ? overrideReasonOf(opts.overrideReason) : null;
  if (block) {
    if (reason === null) return { result: refused("override_required") };
    if (!sameInstant(opts.auditedAt, rows[0].auditor_checked_at)) return { result: refused("stale") };
  }
  if (mismatch && reason === null) return { result: refused("engine_override_required") };
  // Only a pass goes through on one click: every other verdict, and any flagged input, needs the
  // second confirm.
  const needsConfirm = p.flaggedInputId !== null || p.auditorVerdict !== "pass";
  if (needsConfirm && !opts.confirmed) return { result: refused("needs_confirm") };
  if (!executor) return { result: refused("not_executable") };
  let decision: DecisionRecord | null = null;
  if (auto && opts.autopilot) {
    const checked = await autopilotDecision(q, session, p, rows[0], opts.autopilot, now);
    if ("result" in checked) return checked;
    decision = checked.record;
  }
  // The executor's own early refusal, before anything is approved (see Precheck).
  if (executor.precheck) {
    const stop = await executor.precheck(q, p, now, { session, opts });
    if (stop) throw new Prechecked(stop);
  }
  // Lock the approval in while the row is still locked. Exactly one row must move; anything else
  // means it is no longer waiting, and nothing runs. A block's override is stored in the same
  // statement, only for the verdict the card showed and only if none is stored yet, and a
  // mismatch's the same way, only on the stored mismatch, so the approval and its reason land
  // together or not at all. One fixed statement per case; the same reason fills both. On a kind
  // whose executor reads the person's own values (EDITS_KINDS), the exact edits the precheck just
  // validated ({} for none) are stored in the same statement too (0063), always the last
  // parameter, and that executor plans only from them, so a resume can never write values other
  // than the approved ones.
  const nowIso = now.toISOString();
  const approvedEdits = EDITS_KINDS.has(p.kind) ? JSON.stringify(opts.edits ?? {}) : null;
  // The autopilot's approval: one fixed statement that stores its decision with it, only on a row
  // still waiting with no decision, unflagged, passed by the auditor and matched by the engine.
  if (decision !== null) {
    const moved = await q.execute(
      `UPDATE proposals
          SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              updated_at = CAST($3 AS timestamptz), autopilot_decision = CAST($4 AS jsonb),
              approved_edits = CAST($5 AS jsonb)
        WHERE id = CAST($1 AS uuid) AND status = 'proposed' AND autopilot_decision IS NULL
          AND flagged_input_id IS NULL AND auditor_verdict = 'pass' AND engine_check = 'matched'`,
      [p.id, session.sub, nowIso, JSON.stringify(decision), approvedEdits],
    );
    if (moved !== 1) return { result: refused("already_decided") };
    return { run: { ...p, status: "approved" }, executor };
  }
  const params = reason === null ? [p.id, session.sub, nowIso] : [p.id, session.sub, nowIso, reason];
  const approved = await q.execute(
    block && mismatch
      ? `UPDATE proposals
            SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                updated_at = CAST($3 AS timestamptz), auditor_override_reason = $4,
                auditor_override_by = $2, auditor_override_at = CAST($3 AS timestamptz),
                engine_override_reason = $4, engine_override_by = $2,
                engine_override_at = CAST($3 AS timestamptz), approved_edits = CAST($6 AS jsonb)
          WHERE id = CAST($1 AS uuid) AND status = 'proposed' AND auditor_verdict = 'block'
            AND auditor_override_reason IS NULL
            AND date_trunc('milliseconds', auditor_checked_at) = CAST($5 AS timestamptz)
            AND engine_check = 'mismatch' AND engine_override_reason IS NULL`
      : block
        ? `UPDATE proposals
              SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                  updated_at = CAST($3 AS timestamptz), auditor_override_reason = $4,
                  auditor_override_by = $2, auditor_override_at = CAST($3 AS timestamptz),
                  approved_edits = CAST($6 AS jsonb)
            WHERE id = CAST($1 AS uuid) AND status = 'proposed' AND auditor_verdict = 'block'
              AND auditor_override_reason IS NULL
              AND date_trunc('milliseconds', auditor_checked_at) = CAST($5 AS timestamptz)`
        : mismatch
          ? `UPDATE proposals
                SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                    updated_at = CAST($3 AS timestamptz), engine_override_reason = $4,
                    engine_override_by = $2, engine_override_at = CAST($3 AS timestamptz),
                    approved_edits = CAST($5 AS jsonb)
              WHERE id = CAST($1 AS uuid) AND status = 'proposed'
                AND engine_check = 'mismatch' AND engine_override_reason IS NULL`
          : `UPDATE proposals
                SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                    updated_at = CAST($3 AS timestamptz), approved_edits = CAST($4 AS jsonb)
              WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
    [...(block ? [...params, rows[0].auditor_checked_at] : params), approvedEdits],
  );
  if (approved !== 1) return { result: refused("already_decided") };
  // Never the reason itself: its length only.
  if (reason !== null && block) console.info(`proposal ${p.id} override=stored len=${reason.length}`);
  if (reason !== null && mismatch) console.info(`proposal ${p.id} engine_override=stored len=${reason.length}`);
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
  let checked: Gate;
  try {
    checked = await db.withTenant(session.tenantId, (q) =>
      gate(q, session, proposalId, opts, now, registry),
    );
  } catch (err) {
    if (err instanceof Prechecked) return err.result;
    throw err;
  }
  if ("result" in checked) return checked.result;
  return checked.executor(db, session, checked.run, opts, deps);
}
