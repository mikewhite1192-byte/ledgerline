import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import { AiError, type AiFormat, type AiResult, type AiTool } from "../../ai";
import { NANOCENTS_PER_CENT } from "../../ai/prices";
import type { OpenedTurn, OpenTurnRefusal, TurnStore } from "../../agent/gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../../agent/gateway/types";
import { reasonSentence } from "../../agent/reasons";
import type { Session } from "../../auth/claims";
import type { Queryable } from "../../db";
import { nextSweepChecklist } from "../checklist";
import { runChildCheck, type ChildOutcome, type ValidCheck } from "./check";
import {
  dayUse,
  daySpentSql,
  fanoutLimits,
  fanoutOn,
  lockTenantDay,
  refusedByProvider,
  reserveRunCents,
  settleRunCents,
} from "./limits";
import { PLAN_PROMPT, defaultOrder, planInput, readRoster, validatePlan, type ValidPlan } from "./plan";
import {
  RECONCILE_PROMPT,
  computeCounts,
  fanoutFindingKey,
  reconcileInput,
  validateReconcile,
  type CheckRow,
  type EngineFinding,
  type FanoutCounts,
  type ValidReconcile,
} from "./reconcile";
import { CheckAnswer, PLAN_FORMAT, RECONCILE_FORMAT, parseJson } from "./schemas";

// The sweep's second opinion, run by PAY-SWEEP's slices between find and draft (design 3.1):
//   plan       one ordering call (Muse Wonder) over the week's roster;
//   check      up to `parallel` per-driver checks (Muse Spark) a slice, each under its own row
//              lease inside the run's lease, run together and written one by one;
//   reconcile  the server's counts, a needs_person item for each issue only a check raised, then
//              one comparison call (Muse Wonder) for the prose.
// It reads and labels only: it creates no proposal and computes no number. Every model call is
// held against the run's cap (reserved_cents) before it starts and the switch is read again right
// before it. Each step returns the run's next phase, or "wait" to end the slice.

export type FanoutDeps = {
  complete: CompleteFn;
  callTool: (ctx: GatewayContext, call: ToolCall) => Promise<GatewayOutcome>;
  openTurn: (
    session: Session,
    input: { conversationId: string | null; turnId: string; text: string; now: Date; summaryChars: number },
  ) => Promise<OpenedTurn | { refused: OpenTurnRefusal }>;
  steps: (session: Session) => Pick<TurnStore, "startStep" | "finishStep" | "finishTurn">;
  tools: () => AiTool[];
};

export type FanoutCtx = {
  service: Session;
  runId: string;
  token: string;
  clock: () => Date;
  deadlineAt: number;
  // A tenant transaction that holds the run's lease (PAY-SWEEP's `leased`): it throws when the
  // lease moved, so a stale slice writes nothing.
  leased: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;
  deps: FanoutDeps;
};

// A Wonder call may run this far past the slice's deadline (the route's 30 s limit and the run's
// 40 s lease both cover it), and is only started with this much of the slice left.
const MODEL_OVERRUN_MS = 5_000;
export const MIN_WONDER_MS = 10_000;
const WONDER_TIMEOUT_MS = 25_000;
// A check row's lease: longer than any child can run (childTimeoutMs plus the overrun), so a row
// whose lease lapsed belongs to a slice that died.
export const CHECK_LEASE_S = 30;
// The slack PAY-SWEEP keeps before a slice's deadline, so a slice that starts with sliceMs left
// can still start its checks.
const SLICE_SLACK_MS = 6_000;
const MAX_ATTEMPTS = 2;
// Reasoning and the answer share these caps. Measured on muse-wonder-1.0 at medium effort
// (2026-10-27): a two-driver plan spent 1,720 of 2,400 output tokens on reasoning and was cut off
// before its JSON closed. Each cap is sized so its reserve (output at the Wonder rate plus the
// input) still fits planCents and reconcileCents for a full roster; a bigger request is refused
// too_expensive before anything is sent, and the run goes on without that call.
const PLAN_OUTPUT_TOKENS = 4_800;
const RECONCILE_OUTPUT_TOKENS = 4_000;

// The wrapper refused these before anything was sent: the call cost nothing.
const REFUSED_BEFORE_SENDING: ReadonlySet<string> = new Set([
  "disabled",
  "not_configured",
  "cap",
  "job_cap",
  "too_expensive",
  "bad_request",
  "too_long",
]);
const BUDGET_ERRORS: ReadonlySet<string> = new Set(["cap", "job_cap", "too_expensive"]);
const OFF_ERRORS: ReadonlySet<string> = new Set(["disabled", "not_configured"]);
const CATEGORY = /^[a-z_]{2,40}$/;

type Week = { start: string; end: string };

const centsOf = (nano: number) => Math.max(0, Math.ceil(nano / NANOCENTS_PER_CENT));
const errorCategory = (err: unknown) =>
  err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";

async function runWeek(q: Queryable, runId: string): Promise<Week & { periodId: string }> {
  const rows = await q.query<{ period_id: string; period_start: string; period_end: string }>(
    `SELECT sp.id AS period_id, CAST(sp.period_start AS text) AS period_start, CAST(sp.period_end AS text) AS period_end
       FROM sweep_runs r JOIN settlement_periods sp ON sp.id = r.period_id AND sp.tenant_id = r.tenant_id
      WHERE r.id = CAST($1 AS uuid) AND r.tenant_id = current_tenant_id()`,
    [runId],
  );
  if (!rows[0]) throw new Error("the sweep run's week did not read back");
  return { periodId: rows[0].period_id, start: rows[0].period_start, end: rows[0].period_end };
}

// The run's checklist is ticked in the same update (sweep/checklist.ts).
async function setPhase(q: Queryable, runId: string, phase: "check" | "reconcile" | "draft"): Promise<void> {
  await q.execute(
    `UPDATE sweep_runs SET phase = $2, checklist = COALESCE(CAST($3 AS jsonb), checklist)
      WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()`,
    [runId, phase, await nextSweepChecklist(q, runId, { phase })],
  );
}

// The turn a dead slice left running for the plan or the comparison. Closed before the next try
// opens its own: the try then points the run at the new turn, and the old one would stay running.
const LEFT_TURN_SQL = {
  plan: `UPDATE turns SET status = 'failed', ended_reason = 'abandoned', finished_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND status = 'running' AND id IN (
            SELECT plan_turn_id FROM sweep_fanout
             WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND plan_turn_id IS NOT NULL)`,
  reconcile: `UPDATE turns SET status = 'failed', ended_reason = 'abandoned', finished_at = CAST($2 AS timestamptz)
               WHERE tenant_id = current_tenant_id() AND status = 'running' AND id IN (
                 SELECT reconcile_turn_id FROM sweep_fanout
                  WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND reconcile_turn_id IS NOT NULL)`,
} as const;

async function closeLeftTurn(q: Queryable, fx: FanoutCtx, which: keyof typeof LEFT_TURN_SQL): Promise<void> {
  await q.execute(LEFT_TURN_SQL[which], [fx.runId, fx.clock().toISOString()]);
}

// Opens one turn for a fan-out call, in a conversation of its own: the checks run side by side,
// and a conversation takes one running turn at a time.
async function openFanoutTurn(fx: FanoutCtx, text: string): Promise<{ turnId: string; opened: OpenedTurn } | null> {
  const turnId = randomUUID();
  const opened = await fx.deps.openTurn(fx.service, {
    conversationId: null,
    turnId,
    text,
    now: fx.clock(),
    summaryChars: flags.agentTurnLimits.summaryChars,
  });
  return "refused" in opened ? null : { turnId, opened };
}

type TurnEnd = { ok: boolean; endedReason: string | null; text: string; summary: string; steps: number; calls: number; nano: number };

async function endTurn(fx: FanoutCtx, turnId: string, e: TurnEnd): Promise<void> {
  await fx.deps
    .steps(fx.service)
    .finishTurn(turnId, {
      status: e.ok ? "done" : "failed",
      endedReason: e.endedReason,
      text: e.text,
      summary: e.summary.slice(0, 120),
      stepCount: e.steps,
      modelCallCount: e.calls,
      costNanocents: e.nano,
    })
    .catch((err: unknown) => {
      // The turn row is the trace's, not the run's: the run goes on.
      console.error(`sweep fanout turn ${turnId} finish failed: ${err instanceof Error ? err.name : "unknown"}`);
    });
}

// One Wonder call in its own turn: one model step, the answer or the error's category.
type WonderCall =
  | { ok: true; result: AiResult; cents: number }
  | { ok: false; category: string; cents: number | null };

async function callWonder(
  fx: FanoutCtx,
  turn: { turnId: string; opened: OpenedTurn },
  label: string,
  request: { purpose: string; system: string; user: string; maxOutputTokens: number; maxCostCents: number; format: AiFormat },
): Promise<WonderCall> {
  const steps = fx.deps.steps(fx.service);
  const step = await steps.startStep(turn.turnId, { kind: "model", label });
  const remaining = fx.deadlineAt + MODEL_OVERRUN_MS - fx.clock().getTime();
  try {
    const result = await fx.deps.complete(
      "wonder",
      {
        purpose: request.purpose,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        format: request.format,
        reasoningEffort: "medium",
        maxOutputTokens: request.maxOutputTokens,
        maxCostCents: request.maxCostCents,
        timeoutMs: Math.max(1, Math.min(WONDER_TIMEOUT_MS, Math.floor(remaining))),
        traceId: turn.opened.traceId,
      },
      fx.service,
    );
    await steps.finishStep(turn.turnId, step.id, {
      state: "done",
      modelCallId: result.callId,
      detail: { status: result.status, textChars: result.text.length },
    });
    return { ok: true, result, cents: centsOf(result.costNanocents) };
  } catch (err) {
    const category = errorCategory(err);
    const status = err instanceof AiError ? err.httpStatus : undefined;
    await steps.finishStep(turn.turnId, step.id, { state: "failed", detail: { category } });
    // An answer that never came back cost an unknown amount: the whole hold stays counted. A
    // refusal before sending, or a definite provider refusal (401, 402, 429), cost nothing.
    const free = REFUSED_BEFORE_SENDING.has(category) || refusedByProvider(category, status);
    return { ok: false, category, cents: free ? 0 : null };
  }
}

// ---- Plan ----

type PlanStart =
  | { kind: "next"; phase: "check" | "draft" }
  | { kind: "call"; roster: Awaited<ReturnType<typeof readRoster>>; week: Week; attempts: number };

// Stores the order and one check row per driver, then moves the run to check. Only while the
// fan-out is still planning: a second write of the same run changes nothing.
async function writePlan(
  q: Queryable,
  fx: FanoutCtx,
  plan: ValidPlan,
  status: "checking" | "plan_skipped" | "plan_budget",
  callId: string | null,
): Promise<void> {
  const n = await q.execute(
    `UPDATE sweep_fanout SET status = $2, plan_json = CAST($3 AS jsonb),
            plan_call_id = COALESCE(plan_call_id, CAST($4 AS uuid))
      WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND status = 'planning'`,
    [fx.runId, status, JSON.stringify({ summary: plan.summary, order: plan.order, skipped: plan.skipped }), callId],
  );
  if (n === 1 && plan.order.length > 0) {
    await q.execute(
      `INSERT INTO sweep_fanout_checks (tenant_id, run_id, driver_id, priority, focus, brief)
       SELECT current_tenant_id(), CAST($1 AS uuid), x.driver_id, x.priority, x.focus, x.brief
         FROM jsonb_to_recordset(CAST($2 AS jsonb)) AS x(driver_id uuid, priority smallint, focus jsonb, brief text)
       ON CONFLICT (tenant_id, run_id, driver_id) DO NOTHING`,
      [
        fx.runId,
        JSON.stringify(plan.order.map((o) => ({ driver_id: o.driverId, priority: o.priority, focus: o.focus, brief: o.brief }))),
      ],
    );
  }
  await setPhase(q, fx.runId, "check");
}

export async function planPhase(fx: FanoutCtx): Promise<"plan" | "check" | "draft" | "wait"> {
  const l = fanoutLimits();
  const now = fx.clock();
  const start = await fx.leased(async (q): Promise<PlanStart> => {
    const rows = await q.query<{ status: string; plan_attempts: number | string }>(
      "SELECT status, plan_attempts FROM sweep_fanout WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
      [fx.runId],
    );
    let attempts = 0;
    if (!rows[0]) {
      // The switch went off after find: the run goes on as a plain sweep.
      if (!fanoutOn()) {
        await setPhase(q, fx.runId, "draft");
        return { kind: "next", phase: "draft" };
      }
      // The carrier's daily limits (D3), in its own time zone: over either, no fan-out today.
      const used = await dayUse(q, fx.runId, now);
      if (used.fanoutRuns >= l.runsPerTenantDay || used.cents >= l.tenantDayCents) {
        await q.execute(
          `INSERT INTO sweep_fanout (run_id, tenant_id, status, created_at, finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'skipped_daily_cap', CAST($2 AS timestamptz), CAST($2 AS timestamptz))
           ON CONFLICT DO NOTHING`,
          [fx.runId, now.toISOString()],
        );
        await setPhase(q, fx.runId, "draft");
        return { kind: "next", phase: "draft" };
      }
      await q.execute(
        `INSERT INTO sweep_fanout (run_id, tenant_id, status, created_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'planning', CAST($2 AS timestamptz))
         ON CONFLICT DO NOTHING`,
        [fx.runId, now.toISOString()],
      );
      await q.execute("UPDATE sweep_runs SET fanout = true WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()", [
        fx.runId,
      ]);
    } else if (rows[0].status === "skipped_daily_cap") {
      await setPhase(q, fx.runId, "draft");
      return { kind: "next", phase: "draft" };
    } else if (rows[0].status !== "planning") {
      await setPhase(q, fx.runId, "check");
      return { kind: "next", phase: "check" };
    } else {
      attempts = Number(rows[0].plan_attempts);
    }
    const week = await runWeek(q, fx.runId);
    const roster = await readRoster(q, fx.runId, week, l.maxDrivers);
    // Nobody to order, two tries spent, or the switch went off: the server's own order.
    if (roster.rows.length === 0) {
      await writePlan(q, fx, defaultOrder(roster), "checking", null);
      return { kind: "next", phase: "check" };
    }
    if (!fanoutOn() || !(attempts < MAX_ATTEMPTS)) {
      await writePlan(q, fx, defaultOrder(roster), "plan_skipped", null);
      return { kind: "next", phase: "check" };
    }
    return { kind: "call", roster, week, attempts };
  });
  if (start.kind === "next") return start.phase;
  if (fx.deadlineAt - fx.clock().getTime() < MIN_WONDER_MS) return "wait";

  const { roster, week } = start;
  // The hold and the try are counted together, before the call.
  const held = await fx.leased(async (q) => {
    await closeLeftTurn(q, fx, "plan");
    if (!(await reserveRunCents(q, fx.runId, fx.token, l.planCents))) {
      await writePlan(q, fx, defaultOrder(roster), "plan_budget", null);
      return false;
    }
    await q.execute(
      `UPDATE sweep_fanout SET plan_attempts = plan_attempts + 1
        WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND status = 'planning'`,
      [fx.runId],
    );
    return true;
  });
  if (!held) return "check";
  const attempts = start.attempts + 1;
  const lastTry = attempts >= MAX_ATTEMPTS;

  const turn = await openFanoutTurn(fx, "Second opinion: order the week's drivers");
  if (!turn) {
    // Nothing was sent.
    await fx.leased(async (q) => {
      await settleRunCents(q, fx.runId, fx.token, l.planCents, 0);
      if (lastTry) await writePlan(q, fx, defaultOrder(roster), "plan_skipped", null);
    });
    return lastTry ? "check" : "plan";
  }
  await fx.leased((q) =>
    q.execute("UPDATE sweep_fanout SET plan_turn_id = CAST($2 AS uuid) WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()", [
      fx.runId,
      turn.turnId,
    ]),
  );
  // The switch is read again right before the call.
  const call: WonderCall = fanoutOn()
    ? await callWonder(fx, turn, "Ordering the week's drivers", {
        purpose: "fanout_plan",
        system: PLAN_PROMPT,
        user: planInput(roster, week),
        maxOutputTokens: PLAN_OUTPUT_TOKENS,
        maxCostCents: l.planCents,
        format: PLAN_FORMAT,
      })
    : { ok: false, category: "disabled", cents: 0 };

  const valid = call.ok ? validatePlan(call.result.text, roster) : null;
  const next = await fx.leased(async (q): Promise<"plan" | "check"> => {
    await settleRunCents(q, fx.runId, fx.token, l.planCents, call.cents);
    const callId = call.ok ? call.result.callId : null;
    if (valid) {
      await writePlan(q, fx, valid.plan, "checking", callId);
      return "check";
    }
    if (!call.ok && BUDGET_ERRORS.has(call.category)) {
      await writePlan(q, fx, defaultOrder(roster), "plan_budget", callId);
      return "check";
    }
    if (lastTry || (!call.ok && OFF_ERRORS.has(call.category))) {
      await writePlan(q, fx, defaultOrder(roster), "plan_skipped", callId);
      return "check";
    }
    // Tried again by this slice or the next, while tries are left.
    if (callId) {
      await q.execute(
        "UPDATE sweep_fanout SET plan_call_id = COALESCE(plan_call_id, CAST($2 AS uuid)) WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
        [fx.runId, callId],
      );
    }
    return "plan";
  });
  if (valid && valid.unknown > 0) console.warn(`sweep run ${fx.runId} plan_unknown_driver=${valid.unknown}`);
  await endTurn(fx, turn.turnId, {
    ok: valid !== null,
    endedReason: valid ? null : call.ok ? "unparsed" : call.category,
    text: valid
      ? `Ordered ${valid.plan.order.length} ${valid.plan.order.length === 1 ? "driver" : "drivers"} for a second check.`
      : "The order did not come back. The drivers are checked in the server's order.",
    summary: "Second opinion: order the week's drivers",
    steps: 1,
    calls: call.ok ? 1 : 0,
    nano: call.ok ? call.result.costNanocents : 0,
  });
  return next;
}

// ---- Check ----

type Leased = { id: string; driver_id: string; code: string | null; focus: string; brief: string | null; attempts: number | string };

type CheckStart =
  | { kind: "next"; phase: "reconcile" }
  | { kind: "wait" }
  | { kind: "run"; rows: Leased[]; week: Week };

function focusOf(raw: string): string[] {
  const v = parseJson(raw);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
}

export async function checkPhase(fx: FanoutCtx): Promise<"check" | "reconcile" | "wait"> {
  const l = fanoutLimits();
  if (!fanoutOn()) {
    await fx.leased((q) => setPhase(q, fx.runId, "reconcile"));
    return "reconcile";
  }
  // A check starts only with its full time left in the slice.
  const need = Math.min(l.childTimeoutMs, flags.sweepLimits.sliceMs - SLICE_SLACK_MS);
  if (fx.deadlineAt - fx.clock().getTime() < need) return "wait";
  const now = fx.clock();
  const nowIso = now.toISOString();

  const start = await fx.leased(async (q): Promise<CheckStart> => {
    // The turn of a check a dead slice left running is closed: that check is leased again below
    // or, on its second lease, ends here.
    await q.execute(
      `UPDATE turns SET status = 'failed', ended_reason = 'abandoned', finished_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND status = 'running' AND id IN (
          SELECT turn_id FROM sweep_fanout_checks
           WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND status = 'running'
             AND lease_until <= CAST($2 AS timestamptz)
             AND turn_id IS NOT NULL)`,
      [fx.runId, nowIso],
    );
    // A check a dead slice left running on its second lease is not leased a third time.
    await q.execute(
      `UPDATE sweep_fanout_checks SET status = 'error', lease_token = NULL, lease_until = NULL,
              finished_at = CAST($2 AS timestamptz)
        WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND status = 'running'
          AND lease_until <= CAST($2 AS timestamptz) AND attempts >= $3`,
      [fx.runId, nowIso, MAX_ATTEMPTS],
    );
    // The room is what reserveRunCents would still hold: within the run's cap, within the second
    // opinion's own part of it (the cap less the sweep's own budget), and within what is left of
    // the carrier's day cap across its runs that day. The carrier's lock is taken first, so the
    // hold below fits the room read here.
    await lockTenantDay(q);
    const state = await q.query<{ pending: number | string; live: number | string; room: number | string }>(
      `SELECT COUNT(*) FILTER (WHERE c.status = 'queued' OR (c.status = 'running' AND c.lease_until <= CAST($2 AS timestamptz))) AS pending,
              COUNT(*) FILTER (WHERE c.status = 'running' AND c.lease_until > CAST($2 AS timestamptz)) AS live,
              (SELECT LEAST(r.cap_cents - r.spent_cents - r.reserved_cents,
                            r.cap_cents - $3 - (r.spent_cents - r.own_spent_cents) - r.reserved_cents,
                            $4 - ${daySpentSql("$1")})
                 FROM sweep_runs r
                WHERE r.id = CAST($1 AS uuid) AND r.tenant_id = current_tenant_id()) AS room
         FROM sweep_fanout_checks c WHERE c.run_id = CAST($1 AS uuid) AND c.tenant_id = current_tenant_id()`,
      [fx.runId, nowIso, flags.sweepLimits.maxRunCents, l.tenantDayCents],
    );
    const pending = Number(state[0]?.pending ?? 0);
    const live = Number(state[0]?.live ?? 0);
    const roomCents = Number(state[0]?.room ?? 0);
    if (!Number.isSafeInteger(pending) || !Number.isSafeInteger(live) || !Number.isSafeInteger(roomCents)) {
      throw new Error("the fan-out's check state did not read back");
    }
    if (pending === 0) {
      if (live > 0) return { kind: "wait" };
      await setPhase(q, fx.runId, "reconcile");
      return { kind: "next", phase: "reconcile" };
    }
    const room = Math.floor(Math.max(0, roomCents) / l.driverCents);
    if (room <= 0) {
      // The run's cap or the carrier's day cap is reached: the checks not run are over budget, and
      // the run says it was cut.
      await q.execute(
        `UPDATE sweep_fanout_checks SET status = 'budget', lease_token = NULL, lease_until = NULL,
                finished_at = CAST($2 AS timestamptz)
          WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()
            AND (status = 'queued' OR (status = 'running' AND lease_until <= CAST($2 AS timestamptz)))`,
        [fx.runId, nowIso],
      );
      await q.execute(
        "UPDATE sweep_runs SET truncated_reason = 'cap' WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
        [fx.runId],
      );
      if (live > 0) return { kind: "wait" };
      await setPhase(q, fx.runId, "reconcile");
      return { kind: "next", phase: "reconcile" };
    }
    const k = Math.min(l.parallel, room, pending);
    if (!(await reserveRunCents(q, fx.runId, fx.token, k * l.driverCents))) {
      throw new Error("the fan-out's checks could not be held against the caps");
    }
    const rows = await q.query<Leased>(
      `WITH next AS (
         SELECT id FROM sweep_fanout_checks
          WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND attempts < $5
            AND (status = 'queued' OR (status = 'running' AND lease_until <= CAST($3 AS timestamptz)))
          ORDER BY priority, driver_id
          LIMIT $4
          FOR UPDATE SKIP LOCKED)
       UPDATE sweep_fanout_checks c
          SET status = 'running', lease_token = CAST($2 AS uuid),
              lease_until = CAST($3 AS timestamptz) + make_interval(secs => $6),
              attempts = c.attempts + 1, started_at = CAST($3 AS timestamptz), turn_id = NULL
         FROM next WHERE c.id = next.id AND c.tenant_id = current_tenant_id()
       RETURNING c.id, c.driver_id,
                 (SELECT d.code FROM drivers d WHERE d.id = c.driver_id AND d.tenant_id = current_tenant_id()) AS code,
                 CAST(c.focus AS text) AS focus, c.brief, c.attempts`,
      [fx.runId, fx.token, nowIso, k, MAX_ATTEMPTS, CHECK_LEASE_S],
    );
    // Fewer rows than held: the rest of the hold goes back at once.
    if (rows.length < k) await settleRunCents(q, fx.runId, fx.token, (k - rows.length) * l.driverCents, 0);
    if (rows.length === 0) return { kind: "wait" };
    return { kind: "run", rows, week: await runWeek(q, fx.runId) };
  });
  if (start.kind === "wait") return "wait";
  if (start.kind === "next") return start.phase;

  // The turns are opened one after another (each takes the next seq), then the checks run together.
  const turns: ({ turnId: string; opened: OpenedTurn } | null)[] = [];
  for (const row of start.rows) {
    turns.push(await openFanoutTurn(fx, `Second opinion: check ${row.code ?? "a driver"}`));
  }
  await fx.leased(async (q) => {
    for (let i = 0; i < start.rows.length; i += 1) {
      const t = turns[i];
      if (!t) continue;
      await q.execute(
        `UPDATE sweep_fanout_checks SET turn_id = CAST($3 AS uuid)
          WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND lease_token = CAST($2 AS uuid)
            AND status = 'running'`,
        [start.rows[i].id, fx.token, t.turnId],
      );
    }
  });
  const tools = fx.deps.tools();
  const steps = fx.deps.steps(fx.service);
  const startedAt = fx.clock().getTime();
  const childDeadline = Math.min(startedAt + l.childTimeoutMs, fx.deadlineAt + MODEL_OVERRUN_MS);
  const settled = await Promise.allSettled(
    start.rows.map((row, i): Promise<ChildOutcome> => {
      const t = turns[i];
      if (!t) return Promise.reject(new Error("turn_unavailable"));
      return runChildCheck(
        {
          session: fx.service,
          turnId: t.turnId,
          traceId: t.opened.traceId,
          timeZone: t.opened.timeZone,
          driverId: row.driver_id.toLowerCase(),
          week: { start: start.week.start, end: start.week.end },
          focus: focusOf(row.focus),
          brief: row.brief,
          limits: l,
          startedAt,
          deadlineAt: childDeadline,
        },
        {
          complete: fx.deps.complete,
          callTool: fx.deps.callTool,
          steps,
          tools,
          clock: () => fx.clock().getTime(),
          switchOn: fanoutOn,
        },
      );
    }),
  );

  const done = fx.clock().toISOString();
  const outcomes = settled.map((s, i): { row: Leased; out: ChildOutcome; opened: boolean } => {
    const opened = turns[i] !== null;
    if (s.status === "fulfilled") return { row: start.rows[i], out: s.value, opened };
    console.error(`sweep fanout check ${start.rows[i].id} stopped: ${s.reason instanceof Error ? s.reason.name : "unknown"}`);
    // A check that threw: nothing is known of what it spent, unless its turn never opened.
    return {
      row: start.rows[i],
      out: { status: "error", answer: null, costNanocents: 0, costKnown: !opened, modelCalls: 0, toolSteps: 0, stepCount: 0, droppedSources: 0 },
      opened,
    };
  });
  await fx.leased(async (q) => {
    for (const { row, out } of outcomes) {
      const known = out.costKnown ? centsOf(out.costNanocents) : null;
      // What the run counts for this check: the real cost, or the whole hold when unknown.
      const counted = known === null ? l.driverCents : known;
      const retry = (out.status === "timed_out" || out.status === "error") && Number(row.attempts) < MAX_ATTEMPTS;
      await q.execute(
        `UPDATE sweep_fanout_checks
            SET status = $3, result = CAST($4 AS jsonb), cost_cents = cost_cents + $5,
                finished_at = CASE WHEN $3 = 'queued' THEN NULL ELSE CAST($6 AS timestamptz) END,
                lease_token = NULL, lease_until = NULL
          WHERE id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND lease_token = CAST($2 AS uuid)
            AND status = 'running' AND result IS NULL`,
        [
          row.id,
          fx.token,
          retry ? "queued" : out.status,
          out.status === "done" && out.answer ? JSON.stringify(out.answer) : null,
          counted,
          done,
        ],
      );
      await settleRunCents(q, fx.runId, fx.token, l.driverCents, known);
    }
  });
  for (let i = 0; i < outcomes.length; i += 1) {
    const t = turns[i];
    if (!t) continue;
    const { row, out } = outcomes[i];
    const code = row.code ?? "a driver";
    const n = out.answer?.issues.length ?? 0;
    await endTurn(fx, t.turnId, {
      ok: out.status === "done",
      endedReason: out.status === "done" ? null : out.status,
      text:
        out.status === "done"
          ? n === 0
            ? `Checked ${code}'s week. Nothing to point at.`
            : `Checked ${code}'s week. ${n === 1 ? "One thing" : `${n} things`} to look at.`
          : `The check of ${code}'s week did not finish.`,
      summary: `Second opinion: check ${code}`,
      steps: out.stepCount,
      calls: out.modelCalls,
      nano: out.costNanocents,
    });
  }
  return "check";
}

// ---- Reconcile ----

type ReconcileStart =
  | { kind: "next"; phase: "draft" }
  | { kind: "call"; counts: FanoutCounts; engine: EngineFinding[]; checks: CheckRow[]; attempts: number };

function answerOf(raw: string | null): ValidCheck | null {
  if (raw === null) return null;
  const parsed = CheckAnswer.safeParse(parseJson(raw));
  if (!parsed.success) return null;
  return {
    driverId: parsed.data.driverId.toLowerCase(),
    checkedAll: parsed.data.checkedAll,
    confidence: parsed.data.confidence,
    issues: parsed.data.issues.map((i) => ({
      category: i.category,
      sources: i.sources.map((s) => ({ table: s.table, id: s.id.toLowerCase() })),
      note: i.note,
    })),
  };
}

// Ends the fan-out: the comparison's prose (null when it did not answer), and the run on to draft.
async function finishFanout(q: Queryable, fx: FanoutCtx, answer: ValidReconcile | null, callId: string | null): Promise<void> {
  await q.execute(
    `UPDATE sweep_fanout
        SET reconcile_json = CAST($2 AS jsonb), reconcile_call_id = COALESCE(reconcile_call_id, CAST($3 AS uuid)),
            status = CASE WHEN status IN ('checking', 'reconciling') THEN 'done' ELSE status END,
            finished_at = CAST($4 AS timestamptz)
      WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND finished_at IS NULL`,
    [fx.runId, answer ? JSON.stringify(answer) : null, callId, fx.clock().toISOString()],
  );
  await setPhase(q, fx.runId, "draft");
}

export async function reconcilePhase(fx: FanoutCtx): Promise<"reconcile" | "draft" | "wait"> {
  const l = fanoutLimits();
  const start = await fx.leased(async (q): Promise<ReconcileStart> => {
    const rows = await q.query<{ reconcile_attempts: number | string; finished_at: string | null; has_counts: boolean }>(
      `SELECT reconcile_attempts, CAST(finished_at AS text) AS finished_at, counts IS NOT NULL AS has_counts
         FROM sweep_fanout WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()`,
      [fx.runId],
    );
    const f = rows[0];
    if (!f || f.finished_at !== null) {
      await setPhase(q, fx.runId, "draft");
      return { kind: "next", phase: "draft" };
    }
    const engineRows = await q.query<{ driver_id: string; category: string; record_table: string; record_id: string }>(
      `SELECT DISTINCT driver_id, category, record_table, record_id FROM sweep_items
        WHERE seen_run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() AND finding_key NOT LIKE 'fanout:%'
          AND driver_id IS NOT NULL AND record_table IS NOT NULL AND record_id IS NOT NULL
        ORDER BY driver_id, category, record_table, record_id`,
      [fx.runId],
    );
    const engine: EngineFinding[] = engineRows.map((r) => ({
      driverId: r.driver_id.toLowerCase(),
      category: r.category,
      table: r.record_table,
      id: r.record_id.toLowerCase(),
    }));
    const checkRows = await q.query<{ driver_id: string; status: string; result: string | null }>(
      `SELECT driver_id, status, CAST(result AS text) AS result FROM sweep_fanout_checks
        WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id() ORDER BY priority, driver_id`,
      [fx.runId],
    );
    const checks: CheckRow[] = checkRows.map((r) => {
      const answer = r.status === "done" ? answerOf(r.result) : null;
      return { driverId: r.driver_id.toLowerCase(), status: answer ? "done" : r.status === "done" ? "unparsed" : r.status, answer };
    });
    const { counts, sparkOnly } = computeCounts(engine, checks);
    if (!f.has_counts) {
      const week = await runWeek(q, fx.runId);
      const now = fx.clock().toISOString();
      // An issue only a check raised goes to a person, never to a fix: one item per category and
      // record per week, whichever run raised it first.
      for (const s of sparkOnly) {
        const first = s.sources[0];
        await q.execute(
          `INSERT INTO sweep_items
             (id, tenant_id, run_id, seen_run_id, period_id, finding_key, check_name, category, leg, kind,
              driver_id, record_table, record_id, expected_cents, plan, source_refs, note, status, proposal_id,
              created_at, updated_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
                   $4, 'fanout', $5, 1, 'needs_person', CAST($6 AS uuid), $7, CAST($8 AS uuid), NULL, NULL,
                   CAST($9 AS jsonb), $10, 'needs_person', NULL, CAST($11 AS timestamptz), CAST($11 AS timestamptz))
           ON CONFLICT (tenant_id, period_id, finding_key)
             DO UPDATE SET seen_run_id = EXCLUDED.seen_run_id, updated_at = EXCLUDED.updated_at`,
          [
            randomUUID(),
            fx.runId,
            week.periodId,
            fanoutFindingKey(s),
            s.category,
            s.driverId,
            first.table,
            first.id,
            JSON.stringify(s.sources),
            reasonSentence("sub_agent_flag").slice(0, 300),
            now,
          ],
        );
      }
      await q.execute(
        `UPDATE sweep_fanout SET counts = CAST($2 AS jsonb),
                status = CASE WHEN status = 'checking' THEN 'reconciling' ELSE status END
          WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()`,
        [fx.runId, JSON.stringify(counts)],
      );
    }
    const attempts = Number(f.reconcile_attempts);
    // Nothing for the comparison to say, two tries spent, or the switch went off: the counts stand
    // alone.
    if (!fanoutOn() || counts.drivers_checked === 0 || !(attempts < MAX_ATTEMPTS)) {
      await finishFanout(q, fx, null, null);
      return { kind: "next", phase: "draft" };
    }
    return { kind: "call", counts, engine, checks, attempts };
  });
  if (start.kind === "next") return start.phase;
  if (fx.deadlineAt - fx.clock().getTime() < MIN_WONDER_MS) return "wait";

  const held = await fx.leased(async (q) => {
    await closeLeftTurn(q, fx, "reconcile");
    if (!(await reserveRunCents(q, fx.runId, fx.token, l.reconcileCents))) {
      await finishFanout(q, fx, null, null);
      return false;
    }
    await q.execute(
      "UPDATE sweep_fanout SET reconcile_attempts = reconcile_attempts + 1 WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
      [fx.runId],
    );
    return true;
  });
  if (!held) return "draft";
  const lastTry = start.attempts + 1 >= MAX_ATTEMPTS;

  const turn = await openFanoutTurn(fx, "Second opinion: compare the checks");
  if (!turn) {
    await fx.leased(async (q) => {
      await settleRunCents(q, fx.runId, fx.token, l.reconcileCents, 0);
      if (lastTry) await finishFanout(q, fx, null, null);
    });
    return lastTry ? "draft" : "reconcile";
  }
  await fx.leased((q) =>
    q.execute("UPDATE sweep_fanout SET reconcile_turn_id = CAST($2 AS uuid) WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()", [
      fx.runId,
      turn.turnId,
    ]),
  );
  const checked = new Set(start.checks.filter((c) => c.status === "done").map((c) => c.driverId));
  const call: WonderCall = fanoutOn()
    ? await callWonder(fx, turn, "Comparing the two checks", {
        purpose: "fanout_reconcile",
        system: RECONCILE_PROMPT,
        user: reconcileInput(
          start.counts,
          start.engine.filter((f) => checked.has(f.driverId)),
          start.checks.filter((c) => c.status === "done"),
        ),
        maxOutputTokens: RECONCILE_OUTPUT_TOKENS,
        maxCostCents: l.reconcileCents,
        format: RECONCILE_FORMAT,
      })
    : { ok: false, category: "disabled", cents: 0 };

  const valid = call.ok ? validateReconcile(call.result.text, checked) : null;
  const next = await fx.leased(async (q): Promise<"reconcile" | "draft"> => {
    await settleRunCents(q, fx.runId, fx.token, l.reconcileCents, call.cents);
    const callId = call.ok ? call.result.callId : null;
    const final = valid !== null || lastTry || (!call.ok && (BUDGET_ERRORS.has(call.category) || OFF_ERRORS.has(call.category)));
    if (final) {
      await finishFanout(q, fx, valid, callId);
      return "draft";
    }
    if (callId) {
      await q.execute(
        "UPDATE sweep_fanout SET reconcile_call_id = COALESCE(reconcile_call_id, CAST($2 AS uuid)) WHERE run_id = CAST($1 AS uuid) AND tenant_id = current_tenant_id()",
        [fx.runId, callId],
      );
    }
    return "reconcile";
  });
  await endTurn(fx, turn.turnId, {
    ok: valid !== null,
    endedReason: valid ? null : call.ok ? "unparsed" : call.category,
    text: valid ? "Compared the two checks." : "The comparison did not come back. The counts stand on their own.",
    summary: "Second opinion: compare the checks",
    steps: 1,
    calls: call.ok ? 1 : 0,
    nano: call.ok ? call.result.costNanocents : 0,
  });
  return next;
}
