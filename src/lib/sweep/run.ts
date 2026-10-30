import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { runAudit as auditorRun, type AuditResult } from "../agent/auditor/run";
import { callTool as gatewayCallTool, toolsFor } from "../agent/gateway";
import {
  dbTurnStore,
  openAgentTurn,
  openAgentTurnIn,
  type OpenedTurn,
  type OpenTurnRefusal,
  type TurnStore,
} from "../agent/gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../agent/gateway/types";
import { CLEAN_SQL } from "../agent/proposals/clean";
import { codeToWords } from "../format/labels";
import { EXPLAIN_TIMEOUT_MS, explainFix, type Explained, type ExplainInput } from "../agent/sweep/explain";
import { complete as aiComplete, type AiTool } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import { readCheckInput, readReceivablesInput, readRowsWhereId } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { findPaymentOnWrongInvoice, runAllChecks, type Finding } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { clampToMaxTurns } from "../agent/run-limits";
import { localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import {
  findingInWeek,
  findingKey,
  fixPlanFor,
  receivablesPlanFor,
  settlementPlanFor,
  type FixLeg,
  type PlanLeg,
  type SettlementException,
} from "./plan";
import { fanoutLimits, fanoutOn, lockTenantDay } from "./fanout/limits";
import { checkPhase, planPhase, reconcilePhase, type FanoutCtx, type FanoutDeps } from "./fanout/run";
import { nextSweepChecklist, sweepChecklist, type SweepChecklistChange } from "./checklist";
import { serviceSession } from "./service-session";

// The pay sweep (design 3.2): one run checks one open week, drafts a pay correction for each
// finding it can fix and lists the rest for a person. It only proposes. A run works in slices,
// one request each, under a lease, so a request never runs past the platform's limit and two
// workers never touch one run:
//   find   one slice: run the engine's checks, plan each finding, write one item per leg (the
//          dedupe key is finding_key per week, so a second run adds nothing it already has);
//   plan, check, reconcile
//          the second opinion (fanout/run.ts), only with its switch on and the run started with
//          its larger cap: a model orders the week's drivers, a short check reads each driver's
//          records, and the server compares the checks with the engine's findings; an issue only
//          a check raised is listed for a person. It reads and labels; it never drafts;
//   draft  one item per step: open the item's turn, ask the gateway for the proposal (it checks
//          the limits), save it, check the saved numbers are the engine's, explain it. An item
//          refused for a passing reason (TRANSIENT_REFUSALS) is tried again by a later run, at
//          most MAX_DRAFT_ATTEMPTS times in all; a lasting refusal is never tried again. An item
//          held back by another open proposal for the driver is tried again by a later run once
//          that proposal is no longer open. Each item taken is one of the run's turns: at
//          flags.runLimits.maxTurns the run moves on to audit and the rest wait, found, for the
//          next run;
//   audit  ONE auditor run per slice, first thing (an audit can outlast the draft lease, so this
//          phase's lease is 45 s);
//   done   counts, and the run is closed.
// Every model call is counted against the run's own cap before it starts (rule 29: an answer
// that never came back stays counted). Every item write re-checks the lease token.

export type SweepCounts = Record<
  | "found"
  | "fixes_drafted"
  | "clean"
  | "needs_person"
  | "fixed_earlier"
  | "declined_earlier"
  | "expired_earlier"
  | "refused"
  | "blocked_live"
  | "mismatch"
  | "audit_pending"
  | "over_cap"
  // Fixes still found: the run reached its turn ceiling first, so the next run drafts them.
  | "left",
  number
>;

export type SweepState = {
  runId: string;
  status: "running" | "done" | "failed";
  phase: "find" | "plan" | "check" | "reconcile" | "draft" | "audit" | "done";
  counts: Partial<SweepCounts>;
  truncatedReason: string | null;
  failureCategory: string | null;
};

export type StartResult =
  | { ok: true; runId: string; existing: boolean }
  | { ok: false; category: "disabled" | "bad_request" | "no_open_period" | "not_configured" };

export type AdvanceResult =
  | ({ ok: true } & SweepState)
  | { ok: false; category: "disabled" | "bad_request" | "not_found" | "busy" | "not_configured" };

export type SweepDeps = {
  db?: TenantDb;
  clock?: () => Date;
  callTool?: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  openTurn?: (
    session: Session,
    input: { conversationId: string | null; turnId: string; text: string; now: Date; summaryChars: number },
  ) => Promise<OpenedTurn | { refused: OpenTurnRefusal }>;
  // The second opinion's turns open inside the run's leased transaction, with their ids.
  openTurnIn?: FanoutDeps["openTurnIn"];
  store?: (session: Session) => Pick<TurnStore, "persistProposal" | "finishTurn">;
  explain?: (session: Session, input: ExplainInput) => Promise<Explained>;
  runAudit?: (session: Session, proposalId: string) => Promise<AuditResult>;
  // The second opinion's model calls, turn steps and the tools its checks are offered.
  complete?: CompleteFn;
  steps?: (session: Session) => Pick<TurnStore, "startStep" | "finishStep" | "finishTurn">;
  tools?: () => AiTool[];
};

// The find and draft lease. A draft step may start just over STOP_BEFORE_MS before the slice's
// deadline; the gateway stops by that deadline, then the explanation may take EXPLAIN_TIMEOUT_MS
// more, then the last writes. 40 s covers that with room to spare, and is longer than the route's
// own 30 s limit, so no step outlives its lease while its request is alive.
export const DRAFT_LEASE_S = 40;
const AUDIT_LEASE_S = 45;
// The auditor's own constant (AUDIT_CALL, 10 cents), counted before each runAudit.
const AUDIT_RESERVE_CENTS = 10;
// Stop starting new work this close to the slice's deadline.
export const STOP_BEFORE_MS = 6_000;
// The worst case of one draft step past the slice's deadline: the explanation's own timeout plus
// the writes around it. The lease test holds DRAFT_LEASE_S to it.
export const DRAFT_STEP_OVERRUN_MS = EXPLAIN_TIMEOUT_MS + 5_000;
const ABANDONED_MS = 10 * 60_000;
// Refusals that say nothing about the fix itself: the item's turn could not open, a limit could
// not be read, the screen or the tool errored, or the day's model budget was spent. A later run
// tries such an item again; any other refusal (over the limit, the engine refused, bad args)
// stands.
export const TRANSIENT_REFUSALS = ["turn_unavailable", "limit_unavailable", "screen_error", "tool_failed", "budget"] as const;
// Draft tries per item across runs, the first included.
export const MAX_DRAFT_ATTEMPTS = 3;
// sweep_runs.turns_used's own bound (its CHECK); flags.runLimits.maxTurns clamps it lower.
const MAX_RUN_TURNS = 1000;
const CATEGORY = /^[a-z_]{2,40}$/;

const categoryOf = (value: unknown, fallback: string) =>
  typeof value === "string" && CATEGORY.test(value) ? value : fallback;

const centsOfNano = (nano: number) => Math.max(0, Math.ceil(nano / NANOCENTS_PER_CENT));

class LeaseLost extends Error {
  constructor() {
    super("the sweep run's lease moved to another worker");
    this.name = "LeaseLost";
  }
}

type Run = {
  id: string;
  period_id: string;
  status: SweepState["status"];
  phase: SweepState["phase"];
  cap_cents: number | string;
  conversation_id: string | null;
  counts: string;
  truncated_reason: string | null;
  failure_category: string | null;
};

type Ctx = {
  db: TenantDb;
  tenantId: string;
  service: Session;
  runId: string;
  token: string;
  clock: () => Date;
  deadlineAt: number;
  deps: Required<Omit<SweepDeps, "db" | "clock">>;
};

function stateOf(r: Run): SweepState {
  let counts: Partial<SweepCounts> = {};
  try {
    const v: unknown = JSON.parse(r.counts);
    if (v && typeof v === "object" && !Array.isArray(v)) counts = v as Partial<SweepCounts>;
  } catch {
    // stays empty
  }
  return {
    runId: r.id,
    status: r.status,
    phase: r.phase,
    counts,
    truncatedReason: r.truncated_reason,
    failureCategory: r.failure_category,
  };
}

const RUN_COLUMNS =
  "id, period_id, status, phase, cap_cents, conversation_id, CAST(counts AS text) AS counts, truncated_reason, failure_category";

async function readRun(q: Queryable, runId: string): Promise<Run | null> {
  const rows = await q.query<Run>(`SELECT ${RUN_COLUMNS} FROM sweep_runs WHERE id = CAST($1 AS uuid)`, [runId]);
  return rows[0] ?? null;
}

// The run's open week: the one named (still open), else the single open one.
async function openPeriod(q: Queryable, periodId: string | null) {
  const periods = await q.query<{ id: string; period_start: string; period_end: string }>(
    `SELECT id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end
       FROM settlement_periods WHERE status = 'open'
        AND (CAST($1 AS uuid) IS NULL OR id = CAST($1 AS uuid))`,
    [periodId],
  );
  return periods.length === 1 ? periods[0] : null;
}

function defaults(db: TenantDb, clock: () => Date, deps: SweepDeps): Ctx["deps"] {
  return {
    callTool: deps.callTool ?? ((ctx, call) => gatewayCallTool(ctx, call, { db })),
    openTurn: deps.openTurn ?? ((s, input) => openAgentTurn(s, input, { db, clock })),
    openTurnIn: deps.openTurnIn ?? openAgentTurnIn,
    store: deps.store ?? ((s) => dbTurnStore(s, { db, clock })),
    explain: deps.explain ?? ((s, input) => explainFix(s, input, { ai: { db } })),
    runAudit: deps.runAudit ?? ((s, id) => auditorRun(s, id, { db, clock })),
    complete: deps.complete ?? ((target, request, s) => aiComplete(target, request, s, { db })),
    steps: deps.steps ?? ((s) => dbTurnStore(s, { db, clock })),
    tools: deps.tools ?? (() => toolsFor("operator")),
  };
}

// ---- Start ----

export async function startSweep(
  session: Session,
  input: { runId: string; periodId?: string | null; trigger: "button" | "schedule" },
  deps: SweepDeps = {},
): Promise<StartResult> {
  // The switch is read here, not only by the route.
  if (!flags.sweepEnabled) return { ok: false, category: "disabled" };
  const periodId = input.periodId ?? null;
  if (!isUuid(input.runId) || (periodId !== null && !isUuid(periodId))) return { ok: false, category: "bad_request" };
  // With the second opinion on, the run starts with room for it (design 3.7): the sweep's own
  // spend stays its own number inside the larger cap.
  const secondLook = fanoutOn();
  const cap = secondLook ? fanoutLimits().runCapCents : flags.sweepLimits.maxRunCents;
  if (!Number.isSafeInteger(cap) || cap <= 0) return { ok: false, category: "not_configured" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  if (!(await serviceSession(db, session.tenantId))) return { ok: false, category: "not_configured" };
  const runId = input.runId.toLowerCase();

  return db.withTenant(session.tenantId, async (q): Promise<StartResult> => {
    await assertMembership(q, session);
    // A replayed start returns the same run.
    if (await readRun(q, runId)) return { ok: true, runId, existing: true };
    const period = await openPeriod(q, periodId);
    if (!period) return { ok: false, category: "no_open_period" };
    // A run nobody has touched for ten minutes is given up, so the week can be swept again.
    await q.execute(
      `UPDATE sweep_runs
          SET status = 'failed', failure_category = 'abandoned', lease_until = NULL, lease_token = NULL,
              finished_at = CAST($1 AS timestamptz)
        WHERE status = 'running' AND COALESCE(lease_until, started_at) < CAST($2 AS timestamptz)`,
      [nowIso, new Date(now.getTime() - ABANDONED_MS).toISOString()],
    );
    const running = await q.query<{ id: string }>(
      "SELECT id FROM sweep_runs WHERE period_id = CAST($1 AS uuid) AND status = 'running'",
      [period.id],
    );
    if (running.length > 0) return { ok: true, runId: running[0].id, existing: true };
    // The nightly kicker opens at most one run per week per day in the carrier's zone.
    if (input.trigger === "schedule") {
      const tz = await q.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id = current_tenant_id()");
      const zone = tz[0]?.timezone ?? "UTC";
      const earlier = await q.query<{ id: string; started_at: string }>(
        `SELECT id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
           FROM sweep_runs WHERE period_id = CAST($1 AS uuid) ORDER BY started_at DESC LIMIT 1`,
        [period.id],
      );
      if (earlier[0] && localDateOf(earlier[0].started_at, zone) === localDateOf(nowIso, zone)) {
        return { ok: true, runId: earlier[0].id, existing: true };
      }
    }
    await q.execute(
      `INSERT INTO sweep_runs (id, tenant_id, period_id, trigger, started_by, cap_cents, started_at, checklist)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, CAST($6 AS timestamptz), CAST($7 AS jsonb))
       ON CONFLICT DO NOTHING`,
      [runId, period.id, input.trigger, session.sub, cap, nowIso, JSON.stringify(sweepChecklist(secondLook))],
    );
    const now2 = await q.query<{ id: string }>(
      "SELECT id FROM sweep_runs WHERE period_id = CAST($1 AS uuid) AND status = 'running'",
      [period.id],
    );
    if (now2.length !== 1) throw new Error("the sweep run did not read back");
    return { ok: true, runId: now2[0].id, existing: now2[0].id !== runId };
  });
}

// ---- Advance ----

export async function advanceSweep(
  session: Session,
  runId: string,
  deadlineAt: number,
  deps: SweepDeps = {},
): Promise<AdvanceResult> {
  if (!flags.sweepEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(runId)) return { ok: false, category: "bad_request" };
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const service = await serviceSession(db, session.tenantId);
  if (!service) return { ok: false, category: "not_configured" };
  const token = randomUUID();
  const id = runId.toLowerCase();

  type Taken = { kind: "refused"; refused: "not_found" | "busy" } | { kind: "final" | "run"; run: Run };
  const taken = await db.withTenant(session.tenantId, async (q): Promise<Taken> => {
    await assertMembership(q, session);
    const run = await readRun(q, id);
    if (!run) return { kind: "refused", refused: "not_found" };
    if (run.status !== "running") return { kind: "final", run };
    const got = await q.query<{ id: string }>(
      `UPDATE sweep_runs
          SET lease_token = CAST($2 AS uuid),
              lease_until = CAST($3 AS timestamptz) + CASE WHEN phase = 'audit'
                THEN make_interval(secs => $4) ELSE make_interval(secs => $5) END
        WHERE id = CAST($1 AS uuid) AND status = 'running'
          AND (lease_until IS NULL OR lease_until <= CAST($3 AS timestamptz))
        RETURNING id`,
      [id, token, clock().toISOString(), AUDIT_LEASE_S, DRAFT_LEASE_S],
    );
    if (got.length !== 1) return { kind: "refused", refused: "busy" };
    return { kind: "run", run };
  });
  if (taken.kind === "refused") return { ok: false, category: taken.refused };
  if (taken.kind === "final") return { ok: true, ...stateOf(taken.run) };

  const ctx: Ctx = {
    db,
    tenantId: session.tenantId,
    service,
    runId: id,
    token,
    clock,
    deadlineAt,
    deps: defaults(db, clock, deps),
  };
  try {
    await slice(ctx, taken.run);
  } catch (err) {
    if (!(err instanceof LeaseLost)) {
      await releaseLease(ctx).catch(() => undefined);
      throw err;
    }
  }
  await releaseLease(ctx);
  const after = await db.withTenant(session.tenantId, (q) => readRun(q, id));
  if (!after) return { ok: false, category: "not_found" };
  return { ok: true, ...stateOf(after) };
}

// The lease is handed back with the time of the last work, so the next slice starts at once and
// a start can tell a run nobody is carrying on.
async function releaseLease(ctx: Ctx): Promise<void> {
  await ctx.db.withTenant(ctx.tenantId, (q) =>
    q.execute(
      `UPDATE sweep_runs SET lease_until = CAST($3 AS timestamptz), lease_token = NULL
        WHERE id = CAST($1 AS uuid) AND lease_token = CAST($2 AS uuid)`,
      [ctx.runId, ctx.token, ctx.clock().toISOString()],
    ),
  );
}

// Inside a tenant transaction: the run is still this worker's, locked until the commit.
async function holdLease(q: Queryable, ctx: Ctx): Promise<void> {
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM sweep_runs
      WHERE id = CAST($1 AS uuid) AND lease_token = CAST($2 AS uuid) AND status = 'running'
      FOR UPDATE`,
    [ctx.runId, ctx.token],
  );
  if (rows.length !== 1) throw new LeaseLost();
}

const leased = <T>(ctx: Ctx, fn: (q: Queryable) => Promise<T>) =>
  ctx.db.withTenant(ctx.tenantId, async (q) => {
    await holdLease(q, ctx);
    return fn(q);
  });

const timeLeft = (ctx: Ctx) => ctx.deadlineAt - ctx.clock().getTime() > STOP_BEFORE_MS;

async function setPhase(ctx: Ctx, phase: SweepState["phase"]): Promise<void> {
  await leased(ctx, async (q) =>
    q.execute("UPDATE sweep_runs SET phase = $2, checklist = COALESCE(CAST($3 AS jsonb), checklist) WHERE id = CAST($1 AS uuid)", [
      ctx.runId,
      phase,
      await nextSweepChecklist(q, ctx.runId, { phase }),
    ]),
  );
}

function fanoutCtx(ctx: Ctx): FanoutCtx {
  return {
    service: ctx.service,
    runId: ctx.runId,
    token: ctx.token,
    clock: ctx.clock,
    deadlineAt: ctx.deadlineAt,
    leased: (fn) => leased(ctx, fn),
    deps: {
      complete: ctx.deps.complete,
      callTool: ctx.deps.callTool,
      openTurnIn: ctx.deps.openTurnIn,
      steps: ctx.deps.steps,
      tools: ctx.deps.tools,
    },
  };
}

async function slice(ctx: Ctx, run: Run): Promise<void> {
  let phase = run.phase;
  if (phase === "find") {
    const next = await findPhase(ctx, run);
    if (!next) return;
    phase = next;
    if (!timeLeft(ctx)) return;
  }
  // The second opinion's phases, one step at a time while the slice has time; "wait" ends the
  // slice and the next one carries on.
  while (phase === "plan" || phase === "check" || phase === "reconcile") {
    const fx = fanoutCtx(ctx);
    const next: Run["phase"] | "wait" =
      phase === "plan" ? await planPhase(fx) : phase === "check" ? await checkPhase(fx) : await reconcilePhase(fx);
    if (next === "wait") return;
    phase = next;
    if (!timeLeft(ctx)) return;
  }
  if (phase === "draft") {
    while (timeLeft(ctx)) {
      const step = await draftNext(ctx);
      if (step === "cap") return finishRun(ctx, "cap");
      // At the run's turn ceiling the rest stay found for the next run, and what was drafted
      // still gets its second check.
      if (step === "none" || step === "max_turns") {
        await setPhase(ctx, "audit");
        // The audit phase needs its longer lease: the next slice takes it.
        return;
      }
    }
    return;
  }
  if (phase === "audit") {
    const step = await auditNext(ctx);
    if (step === "none") return finishRun(ctx, null);
    if (step === "disabled") return finishRun(ctx, null, { skipped: "audit" });
    if (step === "cap") return finishRun(ctx, "cap");
    return;
  }
  return finishRun(ctx, null);
}

// ---- Find ----

type Planned = { key: string; check: string; category: string; leg: PlanLeg; sources: Finding["sources"]; order: string };

// The run's next phase once its findings are written (null when the run failed): the second
// opinion when its switch is on and the run was started with room for it, else draft.
async function findPhase(ctx: Ctx, run: Run): Promise<"plan" | "draft" | null> {
  const now = ctx.clock().toISOString();
  return leased(ctx, async (q) => {
    const [period] = await readRowsWhereId(q, "settlement_periods", "id", run.period_id);
    if (!period || period.status !== "open") {
      await failRun(q, ctx, "no_open_period", now);
      return null;
    }
    const window = { start: period.period_start, end: period.period_end };
    const input = await readCheckInput(q);
    const codes = new Map(input.drivers.map((d) => [d.id, d.code]));
    const groups: Planned[][] = [];
    const add = (f: Pick<Finding, "check" | "category" | "sources">, legs: PlanLeg[]) => {
      const first = legs[0];
      const order = `${(first && codes.get(first.driverId ?? "")) ?? "~"}:${f.check}`;
      groups.push(
        legs.map((leg) => ({ key: findingKey(f, leg.leg), check: f.check, category: f.category, leg, sources: f.sources, order })),
      );
    };
    // The engine reads every record the carrier has; only a finding whose record at fault falls in
    // this week is this run's, so an earlier week's problem never takes a place or drafts a fix.
    for (const f of runAllChecks(input)) {
      if (findingInWeek(f, input, window)) add(f, fixPlanFor(f, input, window));
    }
    const receivables = await readReceivablesInput(q, period.period_end);
    for (const f of findPaymentOnWrongInvoice(receivables)) add(f, receivablesPlanFor(f, receivables));
    for (const e of await settlementExceptions(q, period.id)) {
      add({ check: "settlement" as Finding["check"], category: e.category as Finding["category"], sources: [{ table: "settlements", id: e.settlementId }] }, settlementPlanFor(e, input));
    }
    // A finding this week already settled (drafted, decided earlier, listed for a person, or
    // refused for good) needs no work: it joins this run without taking one of the maxItems
    // places, because the engine reports it again every run and would otherwise hold the same
    // places all week. The other findings take the places by (driver code, check); the rest wait
    // for a later run, which they reach as the ones before them settle.
    groups.sort((a, b) => (a[0].order < b[0].order ? -1 : a[0].order > b[0].order ? 1 : a[0].key < b[0].key ? -1 : 1));
    const settled = await settledKeys(q, run.period_id);
    const max = Math.max(0, flags.sweepLimits.maxItems);
    const seenAgain: string[] = [];
    const kept: Planned[][] = [];
    let waiting = 0;
    for (const g of groups) {
      if (g.every((p) => settled.has(p.key))) seenAgain.push(...g.map((p) => p.key));
      else if (kept.length < max) kept.push(g);
      else waiting += 1;
    }
    if (seenAgain.length > 0) {
      await q.execute(
        `UPDATE sweep_items SET seen_run_id = CAST($1 AS uuid), updated_at = CAST($4 AS timestamptz)
          WHERE period_id = CAST($2 AS uuid)
            AND finding_key IN (SELECT jsonb_array_elements_text(CAST($3 AS jsonb)))`,
        [ctx.runId, run.period_id, JSON.stringify(seenAgain), now],
      );
    }
    for (const leg of kept.flat()) await writeItem(q, ctx, run, leg, now);
    const next = fanoutOn() && Number(run.cap_cents) >= fanoutLimits().runCapCents ? "plan" : "draft";
    await q.execute(
      `UPDATE sweep_runs SET phase = $3, truncated_reason = $2, checklist = COALESCE(CAST($4 AS jsonb), checklist)
        WHERE id = CAST($1 AS uuid)`,
      [ctx.runId, waiting > 0 ? "max_items" : null, next, await nextSweepChecklist(q, ctx.runId, { phase: next })],
    );
    return next;
  });
}

// This week's findings that no run drafts again: every status but found and over_cap (the draft
// phase takes those), less a refusal for a passing reason with tries left and an item blocked by
// a proposal that is no longer open (writeItem puts both back).
async function settledKeys(q: Queryable, periodId: string): Promise<Set<string>> {
  const rows = await q.query<{ finding_key: string }>(
    `SELECT finding_key FROM sweep_items
      WHERE period_id = CAST($1 AS uuid) AND status NOT IN ('found', 'over_cap')
        AND NOT (kind = 'fix' AND status = 'refused' AND refusal_category = ANY(CAST($2 AS text[]))
                 AND draft_attempts < $3)
        AND NOT (kind = 'fix' AND status = 'blocked_live' AND ${BLOCKER_GONE_SQL})`,
    [periodId, `{${TRANSIENT_REFUSALS.join(",")}}`, MAX_DRAFT_ATTEMPTS],
  );
  return new Set(rows.map((r) => r.finding_key));
}

// A blocked_live item's blocking proposal (its proposal_id) is no longer waiting or running: a
// person decided it, it ran, failed or expired. No open proposal covers the driver now. A missing
// proposal is not "gone": the item stays blocked.
const BLOCKER_GONE_SQL = `EXISTS (SELECT 1 FROM proposals bp WHERE bp.id = sweep_items.proposal_id
  AND bp.status NOT IN ('proposed', 'approved', 'executing'))`;

// The stored settlement exceptions the checks do not cover (SETTLEMENTS' pay-run proposals).
// Until that item merges no such proposal exists and this reads nothing.
async function settlementExceptions(q: Queryable, periodId: string): Promise<SettlementException[]> {
  const rows = await q.query<{ settlement_id: string; driver_id: string; category: string }>(
    `SELECT DISTINCT s.id AS settlement_id, s.driver_id, e.category
       FROM proposals p
       JOIN settlements s ON s.id = p.subject_id AND s.period_id = CAST($1 AS uuid)
       CROSS JOIN LATERAL jsonb_array_elements_text(p.exceptions) AS e(category)
      WHERE p.kind = 'settlement_approve' AND p.status = 'proposed' AND p.subject_table = 'settlements'
        AND e.category IN ('load_rate_missing', 'net_below_zero')
      ORDER BY s.id, e.category`,
    [periodId],
  );
  return rows.map((r) => ({
    settlementId: r.settlement_id,
    driverId: r.driver_id,
    category: r.category as SettlementException["category"],
  }));
}

// A pay correction for this driver and this record that already ran, that a person turned down,
// or that expired with nobody deciding, in any week: the engine still reports the finding, because
// a correction does not clear it, so without this a second week would pay it twice. An expired
// one is not drafted again either (its dedupe key is taken), and says so as its own outcome.
async function earlierFix(q: Queryable, leg: FixLeg, at: Finding["sources"][number]) {
  const rows = await q.query<{ id: string; status: string }>(
    `SELECT id, status FROM proposals
      WHERE kind = 'pay_correction' AND subject_id = CAST($1 AS uuid)
        AND sources @> CAST($2 AS jsonb) AND status IN ('done', 'rejected', 'expired')
      ORDER BY (status = 'done') DESC, created_at DESC LIMIT 1`,
    [leg.driverId, JSON.stringify([{ table: at.table, id: at.id }])],
  );
  if (!rows[0]) return null;
  return { proposalId: rows[0].id, status: earlierOutcome(rows[0].status) };
}

// The item's word for an earlier proposal with the same fix: done, expired with nobody deciding,
// or turned down (rejected, or failed when it ran).
export function earlierOutcome(proposalStatus: string): "fixed_earlier" | "expired_earlier" | "declined_earlier" {
  if (proposalStatus === "done") return "fixed_earlier";
  if (proposalStatus === "expired") return "expired_earlier";
  return "declined_earlier";
}

async function writeItem(q: Queryable, ctx: Ctx, run: Run, p: Planned, now: string): Promise<void> {
  const at = p.sources[0];
  const leg = p.leg;
  let status = leg.kind === "fix" ? "found" : "needs_person";
  let proposalId: string | null = null;
  if (leg.kind === "fix") {
    const earlier = await earlierFix(q, leg, at);
    if (earlier) {
      status = earlier.status;
      proposalId = earlier.proposalId;
    }
  }
  await q.execute(
    `INSERT INTO sweep_items
       (id, tenant_id, run_id, seen_run_id, period_id, finding_key, check_name, category, leg, kind,
        driver_id, record_table, record_id, expected_cents, plan, source_refs, note, status, proposal_id,
        created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
             $4, $5, $6, $7, $8, CAST($9 AS uuid), $10, CAST($11 AS uuid), $12, CAST($13 AS jsonb),
             CAST($14 AS jsonb), $15, $16, CAST($17 AS uuid), CAST($18 AS timestamptz), CAST($18 AS timestamptz))
     ON CONFLICT (tenant_id, period_id, finding_key)
       DO UPDATE SET seen_run_id = EXCLUDED.seen_run_id, updated_at = EXCLUDED.updated_at,
         status = CASE WHEN ${RETRY_SQL} THEN EXCLUDED.status ELSE sweep_items.status END,
         refusal_category = CASE WHEN ${RETRY_SQL} THEN NULL ELSE sweep_items.refusal_category END,
         proposal_id = CASE WHEN ${RETRY_SQL} THEN EXCLUDED.proposal_id ELSE sweep_items.proposal_id END`,
    [
      randomUUID(),
      ctx.runId,
      run.period_id,
      p.key,
      p.check,
      p.category,
      leg.leg,
      leg.kind,
      leg.driverId ?? null,
      at?.table ?? null,
      at?.id ?? null,
      leg.kind === "fix" ? leg.expectedCents : null,
      leg.kind === "fix" ? JSON.stringify(leg) : null,
      JSON.stringify(p.sources.slice(0, 16)),
      leg.kind === "needs_person" ? leg.text.slice(0, 300) : null,
      status,
      proposalId,
      now,
      `{${TRANSIENT_REFUSALS.join(",")}}`,
      MAX_DRAFT_ATTEMPTS,
    ],
  );
}

// A new run that finds an item refused for a passing reason with tries left, or blocked by a
// proposal that is no longer open, puts it back so this run drafts it again. It takes the status
// and proposal this run's earlierFix gave: found, or the earlier fix's own outcome when the same
// fix already ran, was turned down or expired (the blocker may have been that fix), so a fix is
// never drafted twice. Every SET expression reads the row as it was.
const RETRY_SQL = `(sweep_items.seen_run_id <> EXCLUDED.seen_run_id AND sweep_items.kind = 'fix'
  AND ((sweep_items.status = 'refused' AND sweep_items.refusal_category = ANY(CAST($19 AS text[]))
        AND sweep_items.draft_attempts < $20)
    OR (sweep_items.status = 'blocked_live' AND ${BLOCKER_GONE_SQL})))`;

// ---- Draft ----

type Item = {
  id: string;
  check_name: string;
  category: string;
  driver_id: string;
  driver_code: string | null;
  expected_cents: number | string;
  plan: string;
  explanation: string | null;
  status: string;
};

type Step = "done" | "none" | "cap" | "max_turns";

type DraftItem = Item & { period_id: string; period_start: string; period_end: string; conversation_id: string | null };

async function draftNext(ctx: Ctx): Promise<Step> {
  const next = await leased(ctx, async (q) => {
    const rows = await q.query<DraftItem>(
      `SELECT i.id, i.check_name, i.category, i.driver_id, d.code AS driver_code, i.expected_cents,
              CAST(i.plan AS text) AS plan, i.explanation, i.status, i.period_id,
              CAST(sp.period_start AS text) AS period_start, CAST(sp.period_end AS text) AS period_end,
              r.conversation_id
         FROM sweep_items i
         JOIN sweep_runs r ON r.id = i.seen_run_id
         JOIN settlement_periods sp ON sp.id = i.period_id
         LEFT JOIN drivers d ON d.id = i.driver_id
         LEFT JOIN sweep_fanout_checks fc ON fc.run_id = i.seen_run_id AND fc.driver_id = i.driver_id
        WHERE i.seen_run_id = CAST($1 AS uuid) AND i.kind = 'fix' AND i.status IN ('found', 'over_cap')
        ORDER BY fc.priority NULLS LAST, d.code NULLS LAST, i.check_name, i.leg, i.finding_key
        LIMIT 1`,
      [ctx.runId],
    );
    if (rows.length === 0 || (await takeTurn(q, ctx.runId))) return rows;
    return "max_turns" as const;
  });
  if (next === "max_turns") return "max_turns";
  const item = next[0];
  if (!item) return "none";
  const code = item.driver_code ?? "a driver";
  const opened: { turn: TurnRef | null } = { turn: null };
  try {
    return await draftItem(ctx, item, code, opened);
  } catch (err) {
    if (err instanceof LeaseLost) throw err;
    // Any other stop (a database error, a lost answer) ends this item, not the run: it is refused
    // for a passing reason, so its draft_attempts count it and MAX_DRAFT_ATTEMPTS ends the tries,
    // and the run goes on to the next item. Whether a proposal was saved before the stop is
    // unknown, so none is linked here: a later run's retry asks the gateway again, and the
    // proposal's own dedupe key (kind, driver, args) hands back the one already saved, if any, so a
    // fix is never drafted twice. Only the error's name is logged.
    console.error(`sweep item ${item.id} draft stopped: ${err instanceof Error ? err.name : "unknown"}`);
    if (opened.turn?.running) {
      await finishItemTurn(ctx, item, code, "failed", "sweep_refused", "This fix could not be drafted.").catch(
        () => undefined,
      );
    }
    await writeStatus(ctx, item.id, { status: "refused", refusal: "tool_failed" });
    return "done";
  }
}

// One turn of the run's ceiling, taken in the same transaction that picks the item. It counts
// as the item is taken, before its draft, so an item a cut-off slice dropped still counts and a
// crash never lifts the ceiling. At the ceiling the run is marked (unless the find step already
// took the first findings only, which says the same thing: run it again for the rest).
async function takeTurn(q: Queryable, runId: string): Promise<boolean> {
  const took = await q.query<{ turns_used: number }>(
    `UPDATE sweep_runs SET turns_used = turns_used + 1
      WHERE id = CAST($1 AS uuid) AND turns_used < $2
      RETURNING turns_used`,
    [runId, clampToMaxTurns(MAX_RUN_TURNS)],
  );
  if (took.length === 1) return true;
  await q.execute(
    "UPDATE sweep_runs SET truncated_reason = COALESCE(truncated_reason, 'max_turns') WHERE id = CAST($1 AS uuid)",
    [runId],
  );
  return false;
}

async function finishItemTurn(
  ctx: Ctx,
  item: Item,
  code: string,
  status: "done" | "failed",
  endedReason: string,
  text: string,
): Promise<void> {
  await ctx.deps.store(ctx.service).finishTurn(item.id, {
    status,
    endedReason,
    text,
    summary: `Sweep: ${codeToWords(item.check_name)} for ${code}`.slice(0, 120),
    stepCount: 1,
    modelCallCount: 0,
    costNanocents: 0,
  });
}

async function draftItem(ctx: Ctx, item: DraftItem, code: string, opened: { turn: TurnRef | null }): Promise<Step> {
  const leg = JSON.parse(item.plan) as FixLeg;
  const expected = Number(item.expected_cents);
  const now = ctx.clock();

  // a. The item's turn: every proposal has one. The turn id is the item id, so a resumed item
  //    finds its own turn again.
  const turn = await itemTurn(ctx, item, code, item.conversation_id, `${item.period_start} to ${item.period_end}`);
  opened.turn = turn;
  if (!turn) {
    await writeStatus(ctx, item.id, { status: "refused", refusal: "turn_unavailable" });
    return "done";
  }

  // b. The gateway checks the limits and builds the draft. The sweep never builds one itself.
  const args = {
    driverId: leg.driverId,
    periodId: item.period_id,
    ...(leg.payItemId ? { payItemId: leg.payItemId } : {}),
    deltaCents: expected,
    operatorVerdict: leg.verdict,
    reasonCategories: leg.reasonCategories,
    sourceRefs: leg.sourceRefs.slice(0, 8),
  };
  const outcome = await ctx.deps.callTool(
    {
      session: ctx.service,
      role: "operator",
      model: "spark",
      turnId: item.id,
      traceId: turn.traceId,
      now,
      deadlineAt: ctx.deadlineAt,
      timeZone: turn.timeZone,
    },
    { id: `sweep_${item.id.slice(0, 8)}`, name: "propose_pay_correction", argumentsJson: JSON.stringify(args) },
  );
  const store = ctx.deps.store(ctx.service);
  const finish = async (status: "done" | "failed", endedReason: string, text: string) => {
    if (!turn.running) return;
    await finishItemTurn(ctx, item, code, status, endedReason, text);
    turn.running = false;
  };
  if (outcome.decision !== "allowed" || !outcome.draft) {
    const refusal = outcome.decision === "allowed" ? "no_draft" : categoryOf(outcome.reason, "refused");
    await finish("failed", "sweep_refused", "The checks refused this fix.");
    await writeStatus(ctx, item.id, { status: "refused", refusal });
    return "done";
  }

  // c. Save it. The proposal's own dedupe key keeps a replay to one card.
  const saved = await store.persistProposal({
    turnId: item.id,
    conversationId: turn.conversationId,
    traceId: turn.traceId,
    draft: outcome.draft,
    gatewayDecisionId: outcome.decisionId,
    flaggedInputId: outcome.flaggedInputId ?? null,
  });
  await finish("done", "sweep_drafted", "A fix was proposed for a person to approve.");
  if (saved.kind === "live_exists") {
    await writeStatus(ctx, item.id, { status: "blocked_live", proposalId: saved.proposalId });
    return "done";
  }
  if (saved.kind === "already_decided") {
    await writeStatus(ctx, item.id, { status: earlierOutcome(saved.status), proposalId: saved.proposalId });
    return "done";
  }

  // d. The saved numbers must be the engine's, to the cent. A mismatch marks the proposal with an
  //    exception (so it is never clean) and the item says so.
  const same = await sameNumbers(ctx, saved.proposalId, leg, expected);
  if (!same) {
    await writeStatus(ctx, item.id, { status: "mismatch", proposalId: saved.proposalId });
    return "done";
  }

  // e. The explanation, once per item, counted against the run's cap before the call.
  if (item.explanation !== null) {
    await writeStatus(ctx, item.id, { status: "drafted", proposalId: saved.proposalId });
    return "done";
  }
  const reserve = flags.sweepLimits.maxExplainCents;
  if (!(await reserveCents(ctx, reserve))) {
    await writeStatus(ctx, item.id, { status: "over_cap", proposalId: saved.proposalId });
    return "cap";
  }
  const explained = await ctx.deps.explain(ctx.service, {
    traceId: turn.traceId,
    check: item.check_name,
    category: item.category,
    reasonCategory: leg.reasonCategories[0],
    driverCode: code,
    periodStart: item.period_start,
    periodEnd: item.period_end,
    expectedCents: expected,
    maxCostCents: reserve,
  });
  // No cost back (no answer): the reservation stays counted.
  if (explained.costNanocents !== null) await settleCents(ctx, reserve, centsOfNano(explained.costNanocents));
  await writeStatus(ctx, item.id, {
    status: "drafted",
    proposalId: saved.proposalId,
    explanation: explained.ok ? explained.text : null,
    explainCategory: explained.ok ? null : categoryOf(explained.category, "unknown"),
    explainCallId: explained.callId,
  });
  return "done";
}

type TurnRef = { traceId: string; conversationId: string; timeZone: string; running: boolean };

async function itemTurn(ctx: Ctx, item: Item, code: string, conversationId: string | null, week: string): Promise<TurnRef | null> {
  const now = ctx.clock();
  // A turn left running by a slice that was cut off: this worker holds the lease, so none is live.
  if (conversationId) {
    await leased(ctx, (q) =>
      q.execute(
        `UPDATE turns SET status = 'failed', ended_reason = 'abandoned', finished_at = CAST($3 AS timestamptz)
          WHERE conversation_id = CAST($1 AS uuid) AND status = 'running' AND id <> CAST($2 AS uuid)`,
        [conversationId, item.id, now.toISOString()],
      ),
    );
  }
  const opened = await ctx.deps.openTurn(ctx.service, {
    conversationId,
    turnId: item.id,
    text: `Sweep: ${codeToWords(item.check_name)} for ${code}`.slice(0, 2000),
    now,
    summaryChars: flags.agentTurnLimits.summaryChars,
  });
  if (!("refused" in opened)) {
    if (!conversationId) {
      await leased(ctx, async (q) => {
        await q.execute(
          "UPDATE sweep_runs SET conversation_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid) AND conversation_id IS NULL",
          [ctx.runId, opened.conversationId],
        );
        await q.execute("UPDATE conversations SET title = $2 WHERE id = CAST($1 AS uuid)", [
          opened.conversationId,
          `Sweep ${week}`.slice(0, 120),
        ]);
      });
    }
    return { traceId: opened.traceId, conversationId: opened.conversationId, timeZone: opened.timeZone, running: true };
  }
  if (opened.refused !== "duplicate") return null;
  // The item's turn already exists (an earlier slice or run): carry on with it.
  const rows = await ctx.db.withTenant(ctx.tenantId, (q) =>
    q.query<{ trace_id: string; conversation_id: string; status: string; timezone: string }>(
      `SELECT t.trace_id, t.conversation_id, t.status, tn.timezone
         FROM turns t JOIN tenants tn ON tn.id = t.tenant_id WHERE t.id = CAST($1 AS uuid)`,
      [item.id],
    ),
  );
  const t = rows[0];
  if (!t) return null;
  return { traceId: t.trace_id, conversationId: t.conversation_id, timeZone: t.timezone, running: t.status === "running" };
}

async function sameNumbers(ctx: Ctx, proposalId: string, leg: FixLeg, expected: number): Promise<boolean> {
  return leased(ctx, async (q) => {
    const rows = await q.query<{ amount_cents: number | string; direction: string; subject_id: string; delta: string | null; status: string }>(
      `SELECT amount_cents, direction, subject_id, args->>'deltaCents' AS delta, status
         FROM proposals WHERE id = CAST($1 AS uuid)`,
      [proposalId],
    );
    const p = rows[0];
    if (!p) return false;
    const ok =
      Number(p.amount_cents) === Math.abs(expected) &&
      p.direction === (expected < 0 ? "in" : "out") &&
      p.subject_id.toLowerCase() === leg.driverId.toLowerCase() &&
      p.delta !== null &&
      Number(p.delta) === expected;
    if (!ok && p.status === "proposed") {
      await q.execute(
        `UPDATE proposals SET exceptions = exceptions || CAST('["sweep_mismatch"]' AS jsonb),
                updated_at = CAST($2 AS timestamptz)
          WHERE id = CAST($1 AS uuid) AND status = 'proposed' AND NOT (exceptions ? 'sweep_mismatch')`,
        [proposalId, ctx.clock().toISOString()],
      );
    }
    return ok;
  });
}

type StatusWrite = {
  status: string;
  refusal?: string;
  proposalId?: string;
  explanation?: string | null;
  explainCategory?: string | null;
  explainCallId?: string | null;
};

async function writeStatus(ctx: Ctx, itemId: string, w: StatusWrite): Promise<void> {
  await leased(ctx, (q) =>
    q.execute(
      `UPDATE sweep_items
          SET status = $2, refusal_category = $3, proposal_id = COALESCE(CAST($4 AS uuid), proposal_id),
              draft_attempts = draft_attempts + CASE WHEN $2 = 'refused' THEN 1 ELSE 0 END,
              explanation = CASE WHEN $5 THEN $6 ELSE explanation END,
              explain_category = CASE WHEN $5 THEN $7 ELSE explain_category END,
              explain_call_id = CASE WHEN $5 THEN CAST($8 AS uuid) ELSE explain_call_id END,
              updated_at = CAST($9 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [
        itemId,
        w.status,
        w.refusal ?? null,
        w.proposalId ?? null,
        "explanation" in w || "explainCategory" in w,
        w.explanation ?? null,
        w.explainCategory ?? null,
        w.explainCallId ?? null,
        ctx.clock().toISOString(),
      ],
    ),
  );
}

// ---- Budget ----

// Counts cents against the run's cap before a call; false when they do not fit. The second
// opinion's holds (reserved_cents) count against the same cap. The sweep's own calls also stay
// within the sweep's own budget (sweepLimits.maxRunCents), which the second opinion's larger cap
// does not raise: own_spent_cents is the part of spent_cents these calls counted. These cents add
// to the carrier's day total too (its cap never refuses them), so they are counted under the
// carrier's lock, like the second opinion's holds: a check batch sized from the day's room is
// never undercut by another run's call between the read and the hold.
async function reserveCents(ctx: Ctx, cents: number): Promise<boolean> {
  if (!Number.isSafeInteger(cents) || cents <= 0) return false;
  const rows = await leased(ctx, async (q) => {
    await lockTenantDay(q);
    return q.query<{ id: string }>(
      `UPDATE sweep_runs SET spent_cents = spent_cents + $2, own_spent_cents = own_spent_cents + $2
        WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()
          AND spent_cents + reserved_cents + $2 <= cap_cents AND own_spent_cents + $2 <= $3
        RETURNING id`,
      [ctx.runId, cents, flags.sweepLimits.maxRunCents],
    );
  });
  return rows.length === 1;
}

// Replaces a reservation with the real cost.
async function settleCents(ctx: Ctx, reserved: number, actual: number): Promise<void> {
  await leased(ctx, (q) =>
    q.execute(
      `UPDATE sweep_runs SET spent_cents = GREATEST(0, spent_cents - $2 + $3),
              own_spent_cents = GREATEST(0, own_spent_cents - $2 + $3)
        WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()`,
      [ctx.runId, reserved, actual],
    ),
  );
}

// ---- Audit ----

async function auditNext(ctx: Ctx): Promise<"done" | "none" | "cap" | "disabled"> {
  const max = flags.sweepLimits.maxAuditAttempts;
  const next = await leased(ctx, (q) =>
    q.query<{ id: string; proposal_id: string }>(
      `SELECT i.id, i.proposal_id
         FROM sweep_items i
         JOIN proposals p ON p.id = i.proposal_id
         LEFT JOIN drivers d ON d.id = i.driver_id
         LEFT JOIN sweep_fanout_checks fc ON fc.run_id = i.seen_run_id AND fc.driver_id = i.driver_id
        WHERE i.seen_run_id = CAST($1 AS uuid) AND i.status IN ('drafted', 'audit_pending')
          AND i.audit_attempts < $2 AND p.status = 'proposed' AND p.auditor_verdict IS NULL
        ORDER BY fc.priority NULLS LAST, d.code NULLS LAST, i.check_name, i.leg, i.finding_key
        LIMIT 1`,
      [ctx.runId, max],
    ),
  );
  const item = next[0];
  if (!item) return "none";
  if (!(await reserveCents(ctx, AUDIT_RESERVE_CENTS))) {
    await writeStatus(ctx, item.id, { status: "over_cap" });
    return "cap";
  }
  const result = await ctx.deps.runAudit(ctx.service, item.proposal_id);
  if (result.state === "done") {
    const cost = await ctx.db.withTenant(ctx.tenantId, (q) =>
      q.query<{ cost: string | number | null }>(
        `SELECT m.cost_nanocents AS cost FROM proposals p JOIN model_calls m ON m.id = p.auditor_call_id
          WHERE p.id = CAST($1 AS uuid)`,
        [item.proposal_id],
      ),
    );
    // A verdict with no call behind it (the auditor's budget refusal) cost nothing.
    const actual = cost[0]?.cost == null ? (cost.length === 0 ? 0 : AUDIT_RESERVE_CENTS) : centsOfNano(Number(cost[0].cost));
    await settleCents(ctx, AUDIT_RESERVE_CENTS, actual);
    await writeStatus(ctx, item.id, { status: "drafted" });
    return "done";
  }
  if (result.state === "in_progress") {
    // Not checked yet: retried by a later slice while attempts are under the limit. The
    // reservation stays counted (unknown is not zero).
    await leased(ctx, (q) =>
      q.execute(
        `UPDATE sweep_items SET status = 'audit_pending', audit_attempts = audit_attempts + 1,
                updated_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)`,
        [item.id, ctx.clock().toISOString()],
      ),
    );
    return "done";
  }
  await settleCents(ctx, AUDIT_RESERVE_CENTS, 0);
  if (result.state === "disabled") return "disabled";
  // not_found / not_auditable: nothing to retry; the item keeps its status and is not picked again.
  await leased(ctx, (q) =>
    q.execute("UPDATE sweep_items SET audit_attempts = $2 WHERE id = CAST($1 AS uuid)", [item.id, max]),
  );
  return "done";
}

// ---- Done ----

async function failRun(q: Queryable, ctx: Ctx, category: string, now: string): Promise<void> {
  await q.execute(
    `UPDATE sweep_runs SET status = 'failed', failure_category = $2, finished_at = CAST($3 AS timestamptz),
            lease_until = NULL, lease_token = NULL, checklist = COALESCE(CAST($5 AS jsonb), checklist)
      WHERE id = CAST($1 AS uuid) AND lease_token = CAST($4 AS uuid)`,
    [ctx.runId, category, now, ctx.token, await nextSweepChecklist(q, ctx.runId, { ended: "failed" })],
  );
}

export async function countItems(q: Queryable, runId: string): Promise<SweepCounts> {
  const rows = await q.query<{
    status: string;
    n: string | number;
    drafted: string | number;
    clean: string | number;
    left_fixes: string | number;
  }>(
    `SELECT i.status, COUNT(*) AS n,
            COUNT(*) FILTER (WHERE i.kind = 'fix' AND i.status = 'found') AS left_fixes,
            COUNT(*) FILTER (WHERE i.proposal_id IS NOT NULL AND i.status IN ('drafted', 'mismatch', 'audit_pending', 'over_cap')) AS drafted,
            COUNT(*) FILTER (WHERE p.id IS NOT NULL AND i.status = 'drafted' AND ${CLEAN_SQL}) AS clean
       FROM sweep_items i LEFT JOIN proposals p ON p.id = i.proposal_id
      WHERE i.seen_run_id = CAST($1 AS uuid)
      GROUP BY i.status`,
    [runId],
  );
  const counts: SweepCounts = {
    found: 0,
    fixes_drafted: 0,
    clean: 0,
    needs_person: 0,
    fixed_earlier: 0,
    declined_earlier: 0,
    expired_earlier: 0,
    refused: 0,
    blocked_live: 0,
    mismatch: 0,
    audit_pending: 0,
    over_cap: 0,
    left: 0,
  };
  for (const r of rows) {
    counts.found += Number(r.n);
    counts.left += Number(r.left_fixes);
    counts.fixes_drafted += Number(r.drafted);
    counts.clean += Number(r.clean);
    if (r.status in counts && r.status !== "found") counts[r.status as keyof SweepCounts] += Number(r.n);
  }
  return counts;
}

// The checklist ends with the run: "cap" stopped it with work left, and so did "max_items" (the
// find phase took the first findings only, read here from the run row) and "max_turns" (the
// draft step reached the run's turn ceiling); the audit step switched off is skipped rather than
// done. At the turn ceiling the run still went on to audit what it drafted, so unless that step
// was switched off, the audit is done and only the findings left wait for the next run.
async function finishRun(ctx: Ctx, truncated: string | null, opts: { skipped?: "audit" } = {}): Promise<void> {
  const now = ctx.clock().toISOString();
  const counts = await leased(ctx, async (q) => {
    const counts = await countItems(q, ctx.runId);
    const cut = await q.query<{ truncated_reason: string | null }>(
      "SELECT truncated_reason FROM sweep_runs WHERE id = CAST($1 AS uuid)",
      [ctx.runId],
    );
    const reason = truncated ?? cut[0]?.truncated_reason ?? null;
    const stopped = reason === "cap" || reason === "max_items" || reason === "max_turns";
    const audited = reason === "max_turns" && truncated === null && !opts.skipped;
    const ending: SweepChecklistChange = {
      ended: stopped ? "stopped" : "done",
      ...opts,
      ...(audited ? { stoppedAfter: "audit" as const } : {}),
    };
    await q.execute(
      `UPDATE sweep_runs
          SET status = 'done', phase = 'done', counts = CAST($2 AS jsonb),
              spent_cents = spent_cents + reserved_cents, reserved_cents = 0,
              truncated_reason = COALESCE($3, truncated_reason), finished_at = CAST($4 AS timestamptz),
              lease_until = NULL, lease_token = NULL, checklist = COALESCE(CAST($5 AS jsonb), checklist)
        WHERE id = CAST($1 AS uuid)`,
      [ctx.runId, JSON.stringify(counts), truncated, now, await nextSweepChecklist(q, ctx.runId, ending)],
    );
    await afterSweepDone(q, { runId: ctx.runId, counts });
    return counts;
  });
  console.info(
    `sweep run ${ctx.runId} done found=${counts.found} drafted=${counts.fixes_drafted} clean=${counts.clean}` +
      (truncated ? ` truncated=${truncated}` : ""),
  );
}

// DRIVER-NOTES seam: when that item is on main, its "the sweep finished" carrier note is written
// here, in the same transaction, from the run id and the counts (never a number of its own). Until
// then this does nothing. Do not import driver-notes code anywhere else in the sweep.
export type SweepDone = { runId: string; counts: SweepCounts };
async function afterSweepDone(q: Queryable, done: SweepDone): Promise<void> {
  void q;
  void done;
}
