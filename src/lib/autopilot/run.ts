import { flags } from "../../config/flags";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { executeProposal, type ExecuteDeps } from "../proposals/execute";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { decide, driverOf, isPaused, isPolicyReason, recordOf, type PolicyReason } from "./policy";
import { midnightMs, readDriverToday, readPause, readRule, readToday, readZone, todayStartIso } from "./read";
import { autopilotSession, autopilotSub } from "./session";

// The autopilot's look at one waiting proposal, for the desk loop (src/lib/desk/handlers.ts). It
// reads the proposal, the pause, the rule and today's totals as the carrier's autopilot login and
// asks the policy. Auto: the approval gate decides it all again under the lock and approves, and
// the kind's executor runs (src/lib/proposals/execute.ts). Ask or off: the decision is stored on
// the proposal, which stays waiting for a person. Hold (switched off, unarmed, paused, or no longer
// waiting, or made before the autopilot's start date): nothing is written. It never resumes an approval and never tries one twice: a
// proposal already decided, whatever came of it, is reported and not run again, so an unknown
// outcome is never retried blind. A read that does not answer throws before anything is written.
// No model call.

export type AutopilotOutcome =
  // The gate approved it and the executor answered.
  | { outcome: "approved"; status: string; moneyActionId: string | null }
  // Stored as ask or off: a person decides.
  | { outcome: "decided"; mode: "ask" | "off"; reason: string }
  // Nothing decided or written now.
  | { outcome: "held"; reason: string }
  // Approved, and the executor stopped it.
  | { outcome: "executor_refused"; category: string }
  // Still waiting, refused for now by a check that may pass later.
  | { outcome: "retry"; category: string }
  // Decided before this look: by the autopilot (mine) or by someone else, or already asked.
  | { outcome: "earlier"; status: string; mine: boolean; asked: boolean };

export type AutopilotDeps = ExecuteDeps & { db?: TenantDb };

// Policy reasons that mean "not now", never "a person decides". A proposal made before the start
// date is never the autopilot's, so nothing is stored on it either, and neither is anything on a
// kind not armed yet.
const HOLD_REASONS: ReadonlySet<PolicyReason> = new Set([
  "switched_off",
  "unarmed",
  "paused",
  "not_waiting",
  "before_start",
  "kind_unarmed",
]);

const PROPOSAL_SQL = `SELECT kind, status, CAST(amount_cents AS text) AS amount_cents, flagged_input_id,
       auditor_verdict, engine_check, decided_by, autopilot_decision IS NOT NULL AS asked,
       subject_table, CAST(subject_id AS text) AS subject_id, args->>'driverId' AS driver_arg,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

type ProposalRead = {
  kind: unknown;
  status: unknown;
  amount_cents: unknown;
  flagged_input_id: unknown;
  auditor_verdict: unknown;
  engine_check: unknown;
  decided_by: unknown;
  asked: unknown;
  subject_table: unknown;
  subject_id: unknown;
  driver_arg: unknown;
  created_at: unknown;
};

// One decision, stored once, only while the row still waits with none.
const RECORD_SQL = `UPDATE proposals SET autopilot_decision = CAST($2 AS jsonb), updated_at = CAST($3 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'proposed'
    AND autopilot_decision IS NULL`;

const AFTER_SQL = `SELECT status, decided_by FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

type Looked =
  | { kind: "gone" }
  | { kind: "earlier"; status: string; mine: boolean; asked: boolean }
  | { kind: "hold"; reason: string }
  | { kind: "decided"; mode: "ask" | "off"; reason: string }
  | { kind: "auto"; ruleId: string; version: number };

// The row as it reads now, after a write that reached none: decided by someone else in between.
type Reread = { kind: "gone" } | { kind: "earlier"; status: string; mine: boolean; asked: boolean };

async function reread(q: Queryable, sub: string, proposalId: string): Promise<Reread> {
  const rows = await q.query<ProposalRead>(PROPOSAL_SQL, [proposalId]);
  if (rows.length === 0) return { kind: "gone" };
  const r = rows[0];
  if (rows.length !== 1 || typeof r.status !== "string") throw new DbError("unknown");
  // Still waiting with no decision, yet the write reached nothing: unknown, so it fails closed.
  if (r.status === "proposed" && r.asked !== true) throw new DbError("unknown");
  return { kind: "earlier", status: r.status, mine: r.decided_by === sub, asked: r.asked === true };
}

const amountOf = (v: unknown) => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : Number.NaN);

async function look(q: Queryable, sub: string, proposalId: string, now: Date): Promise<Looked> {
  const rows = await q.query<ProposalRead>(PROPOSAL_SQL, [proposalId]);
  if (rows.length === 0) return { kind: "gone" };
  if (rows.length !== 1) throw new DbError("unknown");
  const r = rows[0];
  if (typeof r.kind !== "string" || typeof r.status !== "string" || typeof r.created_at !== "string") {
    throw new DbError("unknown");
  }
  if (r.status !== "proposed" || r.asked === true) {
    return { kind: "earlier", status: r.status, mine: r.decided_by === sub, asked: r.asked === true };
  }
  const pause = await readPause(q);
  const zone = await readZone(q);
  const rule = await readRule(q, r.kind, false);
  const since = todayStartIso(now, zone);
  const today = await readToday(q, r.kind, sub, since);
  // The driver it pays, on a kind that pays one, and what the autopilot approved for them today.
  const driverId = driverOf(r.kind, {
    subjectTable: typeof r.subject_table === "string" ? r.subject_table : "",
    subjectId: typeof r.subject_id === "string" ? r.subject_id : "",
    args: { driverId: r.driver_arg },
  });
  const driverToday = driverId === null ? null : await readDriverToday(q, r.kind, sub, since, driverId);
  const sw = flags.autopilot;
  const startMs = midnightMs(sw.startDate, zone);
  const createdAtMs = Date.parse(r.created_at);
  const result = decide({
    switch: { enabled: sw.enabled, armed: sw.armed, kinds: sw.kinds },
    paused: isPaused(pause, now.getTime()),
    startMs,
    rule,
    proposal: {
      kind: r.kind,
      driverId,
      status: r.status,
      amountCents: amountOf(r.amount_cents),
      createdAtMs,
      flagged: r.flagged_input_id !== null,
      auditorVerdict: typeof r.auditor_verdict === "string" ? r.auditor_verdict : null,
      engineCheck: typeof r.engine_check === "string" ? r.engine_check : null,
    },
    today,
    driverToday,
  });
  if (result.decision === "hold") {
    // The demo reset's own pause says so in the log.
    const reason = result.reason === "paused" && pause?.pausedBy === "demo_reset" ? "reset_pause" : result.reason;
    return { kind: "hold", reason };
  }
  // Made before the start date (or a start that does not read): not the autopilot's, nothing stored.
  if (!Number.isFinite(startMs) || !Number.isFinite(createdAtMs) || createdAtMs < startMs) {
    return { kind: "hold", reason: "before_start" };
  }
  if (result.decision === "auto") {
    if (!rule) return { kind: "hold", reason: "no_rule" };
    return { kind: "auto", ruleId: rule.id, version: rule.version };
  }
  const record = recordOf({ ...result, decision: result.decision }, rule, today, { id: driverId, today: driverToday });
  const stored = await q.execute(RECORD_SQL, [proposalId, JSON.stringify(record), now.toISOString()]);
  if (stored !== 1) return reread(q, sub, proposalId);
  return { kind: "decided", mode: result.decision, reason: result.reason };
}

// The decision a gate refusal gave: off for a kind the owner set to Off, ask otherwise; its own
// policy reason, or the gate's word under gate_refused. Ids, whole numbers and words only.
const modeOfRefusal = (category: string): "ask" | "off" => (category === "mode_off" ? "off" : "ask");

function askRecord(category: string): string {
  return JSON.stringify({
    mode: modeOfRefusal(category),
    reason: isPolicyReason(category) ? category : "gate_refused",
    gate: /^[a-z][a-z0-9_]{0,39}$/.test(category) ? category : "unknown",
    ruleId: null,
    ruleVersion: null,
    maxCents: null,
    dayMaxCents: null,
    dayMaxCount: null,
    dayCents: null,
    dayCount: null,
    driverId: null,
    driverDayMaxCents: null,
    driverDayCents: null,
  });
}

export async function runAutopilot(
  tenantId: string,
  proposalId: string,
  deps: AutopilotDeps = {},
): Promise<{ ok: true; result: AutopilotOutcome } | { ok: false; category: string }> {
  if (!isUuid(tenantId) || !isUuid(proposalId)) return { ok: false, category: "bad_request" };
  // Read here and again by the gate, inside the transaction that approves.
  if (flags.autopilot.enabled !== true) return { ok: true, result: { outcome: "held", reason: "switched_off" } };
  if (flags.autopilot.armed !== true) return { ok: true, result: { outcome: "held", reason: "unarmed" } };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const session = await autopilotSession(db, tenantId);
  if (!session) return { ok: false, category: "not_configured" };
  const sub = autopilotSub(tenantId);

  const looked = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return look(q, sub, proposalId.toLowerCase(), now);
  });
  switch (looked.kind) {
    case "gone":
      return { ok: false, category: "not_found" };
    case "earlier":
      return { ok: true, result: { outcome: "earlier", status: looked.status, mine: looked.mine, asked: looked.asked } };
    case "hold":
      return { ok: true, result: { outcome: "held", reason: looked.reason } };
    case "decided":
      return { ok: true, result: { outcome: "decided", mode: looked.mode, reason: looked.reason } };
  }

  // Auto: the gate decides again under the lock, approves and runs the executor.
  const out = await executeProposal(
    session,
    proposalId,
    { confirmed: false, autopilot: { ruleId: looked.ruleId, version: looked.version } },
    { ...deps, db, clock: () => now },
  );
  if (out.ok) return { ok: true, result: { outcome: "approved", status: out.status, moneyActionId: out.moneyActionId } };
  // Refused: by the gate (the row still waits, nothing approved) or by the executor after the
  // approval. Read back which; a hold word or a check that may pass later writes nothing.
  const holding = isPolicyReason(out.category) && HOLD_REASONS.has(out.category);
  const after = await db.withTenant(session.tenantId, async (q) => {
    const rows = await q.query<{ status: unknown; decided_by: unknown }>(AFTER_SQL, [proposalId]);
    if (rows.length !== 1 || typeof rows[0].status !== "string") throw new DbError("unknown");
    if (rows[0].status === "proposed" && !holding && !out.retryable) {
      const stored = await q.execute(RECORD_SQL, [proposalId, askRecord(out.category), now.toISOString()]);
      if (stored !== 1) return reread(q, sub, proposalId);
    }
    return { status: rows[0].status, mine: rows[0].decided_by === sub };
  });
  // The ask write reached nothing: decided by someone else in between, so that is the outcome.
  if ("kind" in after) {
    if (after.kind === "gone") return { ok: false, category: "not_found" };
    return { ok: true, result: { outcome: "earlier", status: after.status, mine: after.mine, asked: after.asked } };
  }
  if (after.status !== "proposed") {
    if (!after.mine) return { ok: true, result: { outcome: "earlier", status: after.status, mine: false, asked: false } };
    // Another run of the autopilot decided it first: report that run's outcome, never a failure.
    if (out.category === "already_decided") {
      return { ok: true, result: { outcome: "earlier", status: after.status, mine: true, asked: true } };
    }
    return { ok: true, result: { outcome: "executor_refused", category: out.category } };
  }
  if (holding) return { ok: true, result: { outcome: "held", reason: out.category } };
  if (out.retryable) return { ok: true, result: { outcome: "retry", category: out.category } };
  return { ok: true, result: { outcome: "decided", mode: modeOfRefusal(out.category), reason: out.category } };
}
