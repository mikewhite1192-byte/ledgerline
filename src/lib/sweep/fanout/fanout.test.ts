import { describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { OpenedTurn, StepFinish, StepStart } from "@/lib/agent/gateway/store/types";
import type { StepView } from "@/lib/agent/view";
import type { GatewayContext, GatewayOutcome, ToolCall } from "@/lib/agent/gateway/types";
import { MAX_RESULT_CHARS } from "@/lib/agent/gateway";
import { AiError, type AiRequest, type AiResult } from "@/lib/ai";
import { estimateReserve, NANOCENTS_PER_CENT, priceFor, type TokenPrice } from "@/lib/ai/prices";
import { metaBody } from "@/lib/ai/providers/meta";
import { FINDING_CATEGORIES } from "@/lib/rules-engine/types";
import { DbError, type Queryable } from "@/lib/db";
import { CHECK_PROMPT, CHECK_READS, runChildCheck, sourcesFrom, validateCheck, type ChildDeps, type ChildInput } from "./check";
import { fanoutLimits, refusedByProvider } from "./limits";
import { defaultOrder, PLAN_PROMPT, planInput, validatePlan, type Roster } from "./plan";
import {
  computeCounts,
  fanoutFindingKey,
  RECONCILE_PROMPT,
  reconcileInput,
  validateReconcile,
  type CheckRow,
  type EngineFinding,
} from "./reconcile";
import { MIN_WONDER_MS, openLeasedTurn, PLAN_CALL, RECONCILE_CALL, type FanoutCtx, type FanoutDeps } from "./run";
import { CHECK_CATEGORIES, MAX_ISSUES, MAX_SOURCES, OTHER_CATEGORY, PLAN_FORMAT, RECONCILE_FORMAT, parseJson, scrubFigures } from "./schemas";
import { treeOf, type FanoutCheckRow, type FanoutRow } from "./tree";

// The second opinion's server rules, without a database or a model: the plan, check and
// comparison validators, the child check's reads and caps on a fake clock, gateway and model,
// and the page tree's figure guard.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LOAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ITEM = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FIGURE_OR_RUN = /\$|\d{5,}/;

const roster: Roster = {
  rows: [A, B, C].map((driverId, n) => ({
    driverId,
    code: `D-00${n + 1}`,
    netCents: 100_000 - n,
    loads: 1,
    payItems: 1,
    advances: 0,
    days: 5,
    findings: {},
  })),
  skipped: [{ driverId: UNKNOWN, reason: "over_limit" }],
  payBases: ["per_mile"],
};

describe("scrubFigures", () => {
  it("replaces the whole string when a model wrote a figure, and keeps plain words", () => {
    for (const t of ["owed $40", "short 12345 cents", "about 12.50 less", "the 1,200 mile load"]) {
      expect(scrubFigures(t, "see the records", 100)).toBe("see the records");
    }
    // Short amounts: a number with a currency word or sign, and a decimal of any length.
    for (const t of ["short 45 cents", "owed 1234 cents", "paid 40 dollars", "about 12.5 less", "1 cent off", "45¢ short", "40 USD owed", "USD 40 owed", "40bucks"]) {
      expect(scrubFigures(t, "see the records", 100)).toBe("see the records");
    }
    // Dates, driver codes and counts are not amounts.
    expect(scrubFigures("D-001 had 3 loads on 2026-10-27 and 2 stops", "x", 100)).toBe("D-001 had 3 loads on 2026-10-27 and 2 stops");
    expect(scrubFigures("  two  loads on one day ", "x", 100)).toBe("two loads on one day");
    expect(scrubFigures("abcdef", "x", 3)).toBe("abc");
  });

  it("reads a JSON answer, also inside one code fence", () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseJson("not json")).toBeUndefined();
  });
});

describe("validatePlan", () => {
  const answer = (order: unknown[], summary = "Look at the busy drivers first.") =>
    JSON.stringify({ summary, order, skipped: [] });

  it("drops an unknown id, keeps each driver once, appends the missing ones last and scrubs figures", () => {
    const raw = answer(
      [
        { driverId: B.toUpperCase(), priority: 1, focus: ["no_reimbursement", "made_up"], brief: "Owed $40 on a load." },
        { driverId: UNKNOWN, priority: 1, focus: [], brief: "Not on the roster." },
        { driverId: B, priority: 2, focus: [], brief: "Twice." },
      ],
      "Driver owed 12345 cents first.",
    );
    const got = validatePlan(raw, roster);
    expect(got?.unknown).toBe(1);
    expect(got?.plan.summary).toBe("see the records");
    expect(got?.plan.order).toEqual([
      { driverId: B, priority: 1, focus: ["no_reimbursement"], brief: "see the records" },
      { driverId: A, priority: 3, focus: [], brief: null },
      { driverId: C, priority: 3, focus: [], brief: null },
    ]);
    // Skipped is the server's own list, never the model's.
    expect(got?.plan.skipped).toEqual(roster.skipped);
  });

  it("refuses an answer that does not parse, has extra keys, or orders nobody", () => {
    expect(validatePlan("{", roster)).toBeNull();
    expect(validatePlan(JSON.stringify({ summary: "", order: [], skipped: [], extra: 1 }), roster)).toBeNull();
    expect(validatePlan(answer([]), roster)).toBeNull();
    expect(validatePlan(answer([{ driverId: A, priority: 4, focus: [], brief: "" }]), roster)).toBeNull();
  });

  it("orders every driver at priority 3 by default", () => {
    expect(defaultOrder(roster).order.map((o) => [o.driverId, o.priority])).toEqual([
      [A, 3],
      [B, 3],
      [C, 3],
    ]);
  });
});

describe("sourcesFrom and validateCheck", () => {
  it("lists only the records an allowed read returned", () => {
    expect(sourcesFrom("get_loads", { rows: [{ id: LOAD }, { id: 7 }, null] })).toEqual([{ table: "loads", id: LOAD }]);
    expect(
      sourcesFrom("get_pay_items", { rows: [{ id: ITEM, ref: { table: "loads", id: LOAD } }, { id: ITEM, ref: { table: "secrets", id: LOAD } }] }),
    ).toEqual([
      { table: "pay_items", id: ITEM },
      { table: "loads", id: LOAD },
      { table: "pay_items", id: ITEM },
    ]);
    expect(sourcesFrom("get_driver", { driver: { id: A } })).toEqual([{ table: "drivers", id: A }]);
    expect(sourcesFrom("propose_pay_correction", { rows: [{ id: LOAD }] })).toEqual([]);
  });

  const check = (issues: unknown[], driverId = A) =>
    JSON.stringify({ driverId, checkedAll: true, confidence: "medium", issues });
  const read = new Set([`loads:${LOAD}`]);

  it("keeps only cited records the check read, drops an issue left with none, and scrubs a note", () => {
    const got = validateCheck(
      check([
        { category: "no_reimbursement", sources: [{ table: "loads", id: LOAD.toUpperCase() }, { table: "pay_items", id: ITEM }], note: "Short $12." },
        { category: "rate_missing", sources: [{ table: "pay_items", id: ITEM }], note: "Never read." },
      ]),
      A,
      read,
    );
    expect(got?.dropped).toBe(2);
    expect(got?.answer.issues).toEqual([{ category: "no_reimbursement", sources: [{ table: "loads", id: LOAD }], note: "see the record" }]);
  });

  it("refuses another driver's answer, an unknown category and extra keys", () => {
    expect(validateCheck(check([], B), A, read)).toBeNull();
    expect(validateCheck(check([{ category: "made_up", sources: [{ table: "loads", id: LOAD }], note: "" }]), A, read)).toBeNull();
    expect(validateCheck(JSON.stringify({ driverId: A, checkedAll: true, confidence: "low", issues: [], amountCents: 5 }), A, read)).toBeNull();
  });
});

// ---- The child check on a fake clock, a fake gateway and a fake model ----

const LIMITS = { ...flags.fanoutLimits };
const SESSION = { sub: "service:sweep:t", email: "sweep@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const WEEK = { start: "2026-10-26", end: "2026-11-01" };

function input(over: Partial<ChildInput> = {}): ChildInput {
  return {
    session: SESSION,
    turnId: "turn-1",
    traceId: "trace-1",
    timeZone: "America/Chicago",
    driverId: A,
    week: WEEK,
    focus: [],
    brief: null,
    limits: LIMITS,
    startedAt: 0,
    deadlineAt: 60_000,
    ...over,
  };
}

const result = (over: Partial<AiResult>): AiResult => ({
  callId: `call-${Math.random()}`,
  status: "ok",
  text: "",
  toolCalls: [],
  usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
  costNanocents: NANOCENTS_PER_CENT,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
  ...over,
});

// What the fake gateway returns for each read: the driver, one pay item, one load, no advances.
const READ_RESULTS: Record<string, Record<string, unknown>> = {
  get_driver: { driver: { id: A } },
  get_pay_items: { driverId: A, rows: [{ id: ITEM, ref: null }] },
  get_loads: { driverId: A, rows: [{ id: LOAD }] },
  get_advances: { driverId: A, rows: [] },
};

const allowed = (tool: string): GatewayOutcome =>
  ({
    decision: "allowed",
    decisionId: `d-${tool}`,
    tool,
    tier: "read",
    reason: "ok",
    result: READ_RESULTS[tool] ?? {},
    refs: [],
    latencyMs: 1,
  }) as GatewayOutcome;

function harness(
  answers: ((req: AiRequest) => AiResult | Promise<AiResult>)[],
  opts: { stepMs?: number; readMs?: number; read?: (tool: string) => GatewayOutcome | Promise<GatewayOutcome> } = {},
) {
  let now = 0;
  let n = 0;
  const requests: AiRequest[] = [];
  const complete = vi.fn(async (_t: string, req: AiRequest) => {
    requests.push(req);
    const next = answers[Math.min(n, answers.length - 1)];
    n += 1;
    now += opts.stepMs ?? 0;
    return next(req);
  });
  const callTool = vi.fn(async (_ctx: GatewayContext, call: ToolCall): Promise<GatewayOutcome> => {
    now += opts.readMs ?? 0;
    return (opts.read ?? allowed)(call.name);
  });
  let step = 0;
  const steps = {
    startStep: vi.fn<(turnId: string, s: StepStart) => Promise<StepView>>(async () => ({ id: `s${++step}` }) as StepView),
    finishStep: vi.fn<(turnId: string, id: string, f: StepFinish) => Promise<StepView>>(async () => ({}) as StepView),
  };
  const deps: ChildDeps = {
    complete: complete as unknown as ChildDeps["complete"],
    callTool,
    steps,
    clock: () => now,
    switchOn: () => true,
  };
  return { deps, complete, callTool, steps, requests };
}

const answer = (issues: unknown[] = []) =>
  result({ text: JSON.stringify({ driverId: A, checkedAll: true, confidence: "high", issues }) });

describe("runChildCheck", () => {
  it("reads the driver's four records in order through the gateway, then asks once with no tools and the records in the message", async () => {
    const h = harness([
      () => answer([{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD }], note: "A day with no load." }]),
    ]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(out.answer?.issues).toEqual([{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD }], note: "A day with no load." }]);
    expect(out).toMatchObject({ toolSteps: CHECK_READS.length, modelCalls: 1, stepCount: CHECK_READS.length + 1, costKnown: true });

    // The reads: this driver only, the week's bounds on pay items and loads, as the operator in
    // the check's own turn and trace.
    const calls = h.callTool.mock.calls;
    expect(calls.map((c) => c[1].name)).toEqual(["get_driver", "get_pay_items", "get_loads", "get_advances"]);
    const args = calls.map((c) => JSON.parse(c[1].argumentsJson) as Record<string, unknown>);
    expect(args.every((a) => a.driverId === input().driverId)).toBe(true);
    expect(args[1]).toEqual({ driverId: A, periodStart: WEEK.start, periodEnd: WEEK.end });
    expect(args[2]).toEqual({ driverId: A, from: WEEK.start, to: WEEK.end });
    for (const [ctx] of calls) {
      expect(ctx).toMatchObject({ session: SESSION, role: "operator", turnId: "turn-1", traceId: "trace-1" });
    }

    // Each read is a tool step with the gateway's label and decision, then the one model step.
    expect(h.steps.startStep.mock.calls.map((c) => [c[1].kind, c[1].label])).toEqual([
      ["tool", "Reading the driver"],
      ["tool", "Reading pay items"],
      ["tool", "Reading loads"],
      ["tool", "Reading advances"],
      ["model", "Thinking it through"],
    ]);
    expect(h.steps.finishStep.mock.calls.slice(0, 4).map((c) => c[2].gatewayDecisionId)).toEqual([
      "d-get_driver",
      "d-get_pay_items",
      "d-get_loads",
      "d-get_advances",
    ]);

    // One call, no tools, no replay, the records in the user message.
    expect(h.complete).toHaveBeenCalledTimes(1);
    const req = h.requests[0];
    expect(req.tools).toBeUndefined();
    expect(req.replay).toBeUndefined();
    expect(req).toMatchObject({ purpose: "fanout_check", reasoningEffort: "low" });
    expect(req.maxCostCents).toBe(Math.min(LIMITS.callCents, LIMITS.driverCents));
    const user = JSON.parse(req.messages.find((m) => m.role === "user")?.content ?? "{}") as Record<string, unknown>;
    expect(user).toMatchObject({ driverId: A, week: WEEK, focus: [], brief: "" });
    expect(user.records).toEqual({
      driver: READ_RESULTS.get_driver,
      payItems: READ_RESULTS.get_pay_items,
      loads: READ_RESULTS.get_loads,
      advances: READ_RESULTS.get_advances,
    });
  });

  it("keeps only the sources the reads returned", async () => {
    const h = harness([
      () =>
        answer([
          {
            category: "no_reimbursement",
            sources: [
              { table: "loads", id: LOAD },
              { table: "loads", id: UNKNOWN },
              { table: "pay_items", id: ITEM },
            ],
            note: "Look at the load.",
          },
          { category: "rate_missing", sources: [{ table: "advances", id: UNKNOWN }], note: "Look at the advance." },
        ]),
    ]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(out.droppedSources).toBe(2);
    expect(out.answer?.issues).toEqual([
      {
        category: "no_reimbursement",
        sources: [
          { table: "loads", id: LOAD },
          { table: "pay_items", id: ITEM },
        ],
        note: "Look at the load.",
      },
    ]);
  });

  it("never says it checked everything when a read came back cut at the size cap", async () => {
    const cut = harness([() => answer()], {
      read: (tool) =>
        tool === "get_loads" ? ({ ...allowed(tool), reason: "result_truncated" } as GatewayOutcome) : allowed(tool),
    });
    const out = await runChildCheck(input(), cut.deps);
    expect(out.status).toBe("done");
    expect(out.answer?.checkedAll).toBe(false);
    const whole = await runChildCheck(input(), harness([() => answer()]).deps);
    expect(whole.answer?.checkedAll).toBe(true);
  });

  it("ends as an error with no model call when a read is refused, fails or throws", async () => {
    const refused = (decision: "blocked" | "failed" | "denied", reason: string) => (tool: string) =>
      (tool === "get_loads"
        ? { decision, decisionId: `d-${tool}`, tool, reason, result: { blocked: true }, latencyMs: 0 }
        : allowed(tool)) as GatewayOutcome;
    const reads: ((tool: string) => GatewayOutcome | Promise<GatewayOutcome>)[] = [
      refused("blocked", "unknown_record"),
      refused("failed", "tool_failed"),
      refused("denied", "role_not_allowed"),
      async (tool) => {
        if (tool === "get_loads") throw new Error("lost");
        return allowed(tool);
      },
    ];
    for (const read of reads) {
      const h = harness([() => answer()], { read });
      const out = await runChildCheck(input(), h.deps);
      expect(out).toMatchObject({ status: "error", costKnown: true, costNanocents: 0, modelCalls: 0, toolSteps: 3, stepCount: 3 });
      expect(h.complete).not.toHaveBeenCalled();
      expect(h.callTool).toHaveBeenCalledTimes(3);
      const last = h.steps.finishStep.mock.calls.at(-1)?.[2];
      expect(last?.state).toBe("failed");
    }
  });

  it("ends as timed out with no model call when the clock runs out during the reads", async () => {
    const h = harness([() => answer()], { readMs: 8_000 });
    const out = await runChildCheck(input(), h.deps);
    expect(out).toMatchObject({ status: "timed_out", costKnown: true, modelCalls: 0 });
    expect(h.callTool).toHaveBeenCalledTimes(3);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("ends as timed out when a read fails because the clock ran out inside it, and as an error when time is left", async () => {
    const failed = (tool: string) =>
      (tool === "get_loads"
        ? { decision: "failed", decisionId: `d-${tool}`, tool, reason: "tool_failed", result: { error: "tool_failed" }, latencyMs: 0 }
        : allowed(tool)) as GatewayOutcome;
    // The third read takes the rest of the check's clock and fails, as the gateway's timeout does.
    let now = 0;
    const late = harness([() => answer()], { read: failed });
    late.callTool.mockImplementation(async (_ctx, call) => {
      now += call.name === "get_loads" ? LIMITS.childTimeoutMs : 1_000;
      return failed(call.name);
    });
    const out = await runChildCheck(input(), { ...late.deps, clock: () => now });
    expect(out).toMatchObject({ status: "timed_out", costKnown: true, modelCalls: 0, toolSteps: 3 });
    expect(late.complete).not.toHaveBeenCalled();
    // The same failure with time left is an error.
    const early = harness([() => answer()], { read: failed, readMs: 1_000 });
    expect(await runChildCheck(input(), early.deps)).toMatchObject({ status: "error", modelCalls: 0 });
    expect(early.complete).not.toHaveBeenCalled();
  });

  it("never asks for longer than is left after the reads", async () => {
    const h = harness([() => answer()], { readMs: 2_000 });
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(h.requests[0].timeoutMs).toBeLessThanOrEqual(LIMITS.childTimeoutMs - CHECK_READS.length * 2_000);
  });

  it("reads nothing when the check has fewer tool steps than reads, or no model call", async () => {
    for (const over of [{ maxToolSteps: CHECK_READS.length - 1 }, { maxCallsPerDriver: 0 }]) {
      const h = harness([() => answer()]);
      const out = await runChildCheck(input({ limits: { ...LIMITS, ...over } }), h.deps);
      expect(out).toMatchObject({ status: "error", costKnown: true, stepCount: 0 });
      expect(h.callTool).not.toHaveBeenCalled();
      expect(h.complete).not.toHaveBeenCalled();
    }
  });

  it("stops at the driver's cents", async () => {
    const h = harness([() => answer()]);
    const out = await runChildCheck(input({ limits: { ...LIMITS, driverCents: 0 } }), h.deps);
    expect(out.status).toBe("budget");
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("tells the check what each category means, so a load with no pay item is never flagged", () => {
    expect(CHECK_PROMPT).toContain("a load with no pay item is never an issue");
    expect(CHECK_PROMPT).toContain("never report no_reimbursement");
    // Every snake_case word the meanings name, other than the pay_items table, is a real category.
    const meanings = CHECK_PROMPT.slice(CHECK_PROMPT.indexOf("What each category means"), CHECK_PROMPT.indexOf("Never state"));
    const named = (meanings.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).filter((w) => w !== "pay_items");
    expect(named).toEqual(expect.arrayContaining(["newer_is_duplicate", "rate_missing", "over_load_cap", OTHER_CATEGORY]));
    for (const w of named) expect(CHECK_CATEGORIES).toContain(w);
  });

  it("caps one check call with room for every read at its cap beside its 3,000 output tokens, inside the driver's cents", () => {
    // The wrapper's reserve for a Muse Spark call (src/lib/ai/prices.ts estimateReserve); 3,000 is
    // check.ts's MAX_OUTPUT_TOKENS. The request at its largest: every read at the gateway's result
    // cap, the prompt, and 1,000 for the driver, week, focus and brief around them.
    const price = priceFor("spark", "meta", "muse-spark-1.3") as TokenPrice;
    const request = CHECK_READS.length * MAX_RESULT_CHARS + CHECK_PROMPT.length + 1_000;
    expect(request).toBeLessThanOrEqual(55_000);
    expect(estimateReserve(price, 55_000, 3_000)).toBeLessThanOrEqual(LIMITS.callCents * NANOCENTS_PER_CENT);
    expect(LIMITS.callCents).toBeLessThanOrEqual(LIMITS.driverCents);
    expect(LIMITS.maxToolSteps).toBeGreaterThanOrEqual(CHECK_READS.length);
  });

  it("ends as unparsed when the answer is not the JSON, or names a tool call", async () => {
    for (const reply of [result({ text: "Looks fine." }), result({ toolCalls: [{ id: "tc-1", name: "get_ledger", argumentsJson: "{}" }] })]) {
      const h = harness([() => reply]);
      const out = await runChildCheck(input(), h.deps);
      expect(out).toMatchObject({ status: "unparsed", modelCalls: 1 });
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(h.callTool).toHaveBeenCalledTimes(CHECK_READS.length);
    }
  });

  it("counts a lost answer's cost as unknown, and a refusal before sending as nothing", async () => {
    const lost = harness([
      () => {
        throw new AiError("timeout");
      },
    ]);
    expect(await runChildCheck(input(), lost.deps)).toMatchObject({ status: "timed_out", costKnown: false });
    const capped = harness([
      () => {
        throw new AiError("cap");
      },
    ]);
    expect(await runChildCheck(input(), capped.deps)).toMatchObject({ status: "budget", costKnown: true });
  });

  it("counts a definite provider refusal (401, 402, 429) as nothing, and any other failure as unknown", async () => {
    type Category = "auth" | "billing" | "rate_limited" | "timeout" | "network" | "unavailable" | "unknown";
    const run = (category: Category, status?: number) =>
      runChildCheck(
        input(),
        harness([
          () => {
            throw new AiError(category, status);
          },
        ]).deps,
      );
    for (const [category, status] of [["auth", 401], ["billing", 402], ["rate_limited", 429]] as const) {
      expect(await run(category, status)).toMatchObject({ status: "error", costKnown: true });
    }
    // A 403 is "auth" too, but its outcome is unknown and the wrapper keeps the hold.
    expect(await run("auth", 403)).toMatchObject({ costKnown: false });
    // The category alone is not enough: the status must be the definite one.
    expect(await run("rate_limited")).toMatchObject({ costKnown: false });
    const others: [Category, number | undefined][] = [["unavailable", 503], ["timeout", 504], ["network", undefined], ["unknown", undefined]];
    for (const [category, status] of others) {
      expect(await run(category, status)).toMatchObject({ costKnown: false });
    }
  });

  it("frees only the three definite provider refusals, each with its own status", () => {
    expect(refusedByProvider("auth", 401)).toBe(true);
    expect(refusedByProvider("billing", 402)).toBe(true);
    expect(refusedByProvider("rate_limited", 429)).toBe(true);
    expect(refusedByProvider("auth", 403)).toBe(false);
    expect(refusedByProvider("billing", 401)).toBe(false);
    expect(refusedByProvider("rate_limited", undefined)).toBe(false);
    expect(refusedByProvider("unavailable", 503)).toBe(false);
    expect(refusedByProvider("timeout", 504)).toBe(false);
  });

  it("makes no read and no call when the switch is off, and no call when it goes off during the reads", async () => {
    const h = harness([() => answer()]);
    const out = await runChildCheck(input(), { ...h.deps, switchOn: () => false });
    expect(out.status).toBe("error");
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();

    const later = harness([() => answer()]);
    let reads = 0;
    later.callTool.mockImplementation(async (_ctx, call) => {
      reads += 1;
      return allowed(call.name);
    });
    const off = await runChildCheck(input(), { ...later.deps, switchOn: () => reads === 0 });
    expect(off.status).toBe("error");
    expect(later.callTool).toHaveBeenCalledTimes(CHECK_READS.length);
    expect(later.complete).not.toHaveBeenCalled();
  });
});

describe("computeCounts and validateReconcile", () => {
  const engine: EngineFinding[] = [
    { driverId: A, category: "no_reimbursement", table: "loads", id: LOAD },
    { driverId: A, category: "rate_missing", table: "pay_items", id: ITEM },
    { driverId: C, category: "rate_missing", table: "pay_items", id: ITEM },
  ];
  const done = (driverId: string, issues: { category: "no_reimbursement" | "rate_missing" | "other_for_review"; table: string; id: string }[]): CheckRow => ({
    driverId,
    status: "done",
    answer: {
      driverId,
      checkedAll: true,
      confidence: "high",
      issues: issues.map((i) => ({ category: i.category, sources: [{ table: i.table, id: i.id }], note: "Look." })),
    },
  });

  it("counts by whole-value match on the checked drivers only", () => {
    const { counts, sparkOnly } = computeCounts(engine, [
      done(A, [
        { category: "no_reimbursement", table: "loads", id: LOAD },
        { category: "other_for_review", table: "loads", id: LOAD },
      ]),
      done(B, [{ category: "rate_missing", table: "pay_items", id: ITEM }]),
      { driverId: C, status: "timed_out", answer: null },
    ]);
    expect(counts).toEqual({ engine: 2, agreed: 1, engine_only: 1, spark_only: 2, drivers_checked: 2, drivers_unchecked: 1 });
    expect(sparkOnly.map(fanoutFindingKey)).toEqual([
      `fanout:other_for_review:loads:${LOAD}:1`,
      `fanout:rate_missing:pay_items:${ITEM}:1`,
    ]);
  });

  it("keeps disagreements about checked drivers only and scrubs figures", () => {
    const raw = JSON.stringify({
      summary: "They agree on most of it; one load is short $40.",
      disagreements: [
        { driverId: A, category: "rate_missing", text: "Only the engine saw the missing rate." },
        { driverId: UNKNOWN, category: "rate_missing", text: "Not a checked driver." },
        { driverId: B, category: "other_for_review", text: "Short 12345 cents." },
      ],
    });
    expect(validateReconcile(raw, new Set([A, B]))).toEqual({
      summary: "see the records",
      disagreements: [
        { driverId: A, category: "rate_missing", text: "Only the engine saw the missing rate." },
        { driverId: B, category: "other_for_review", text: "see the records" },
      ],
    });
    expect(validateReconcile("{}", new Set([A]))).toBeNull();
  });
});

describe("treeOf", () => {
  const row: FanoutRow = {
    status: "done",
    plan_turn_id: "t-plan",
    plan_json: JSON.stringify({
      summary: "Start with the driver owed $1,200.50.",
      order: [],
      skipped: [
        { driverId: UNKNOWN, reason: "over_limit" },
        { driverId: C, reason: "no_activity" },
        { driverId: "not-an-id", reason: "over_limit" },
      ],
    }),
    reconcile_turn_id: "t-rec",
    reconcile_json: JSON.stringify({
      summary: "Both found the same problems.",
      disagreements: [
        { driverId: A, category: "rate_missing", text: "Off by 99999." },
        { driverId: A, category: "NOT A CODE", text: "Dropped." },
      ],
    }),
    counts: JSON.stringify({ engine: 2, agreed: 1, engine_only: 1, spark_only: 1, drivers_checked: 1, drivers_unchecked: 1 }),
    finished_at: "2026-11-02 16:00:00+00",
  };
  const checks: FanoutCheckRow[] = [
    {
      driver_id: A.toUpperCase(),
      priority: "1",
      focus: JSON.stringify(["rate_missing", "Bad Focus"]),
      brief: "Paid 12.50 short?",
      status: "done",
      result: JSON.stringify({
        confidence: "high",
        issues: [
          { category: "rate_missing", sources: [{ table: "pay_items", id: ITEM }], note: "Rate is $0." },
          { category: "rate_missing", sources: [{ table: "secrets", id: ITEM }], note: "No allowed record." },
        ],
      }),
      turn_id: "t-a",
      cost_cents: "4",
    },
    { driver_id: B, priority: 3, focus: "[]", brief: null, status: "weird", result: null, turn_id: null, cost_cents: 9 },
  ];
  const names = new Map([[A, { code: "D-001", label: "Pat Lee" }]]);

  it("re-scrubs every model string and keeps only well-formed ids, categories and records", () => {
    const tree = treeOf(row, checks, names);
    expect(tree.plan.summary).toBe("see the records");
    expect(tree.skipped).toEqual([{ driverId: UNKNOWN, driverCode: null, driverLabel: null, reason: "over_limit" }]);
    expect(tree.reconcile.disagreements).toEqual([
      { driverId: A, driverCode: "D-001", driverLabel: "Pat Lee", category: "rate_missing", text: "see the records" },
    ]);
    expect(tree.checks[0]).toMatchObject({
      driverId: A,
      driverCode: "D-001",
      priority: 1,
      focus: ["rate_missing"],
      brief: "see the records",
      confidence: "high",
      issues: [{ category: "rate_missing", sources: [{ table: "pay_items", id: ITEM }], note: "see the record" }],
    });
    expect(tree.checks[1].status).toBe("error");
    expect(tree.reconcile.counts?.spark_only).toBe(1);
    expect(tree.finished).toBe(true);
    // No dollar sign or five-digit run from a model string reaches the page.
    const modelText = [
      tree.plan.summary,
      tree.reconcile.summary,
      ...tree.reconcile.disagreements.map((d) => d.text),
      ...tree.checks.flatMap((c) => [c.brief, ...c.issues.map((i) => i.note)]),
    ];
    for (const t of modelText) expect(t === null || !FIGURE_OR_RUN.test(t)).toBe(true);
  });

  it("reads bad stored JSON as empty, never as a crash", () => {
    const tree = treeOf({ ...row, plan_json: "{", reconcile_json: null, counts: '{"engine":-1}' }, [], names);
    expect(tree.plan.summary).toBeNull();
    expect(tree.reconcile.counts).toBeNull();
    expect(tree.reconcile.disagreements).toEqual([]);
  });
});

// ---- The plan's and the comparison's turn, opened with its id write ----

describe("openLeasedTurn", () => {
  const q = { query: vi.fn(), execute: vi.fn() } as unknown as Queryable;
  // The leased transaction on a fake: whatever its body throws comes out of it (the rollback).
  const ctx = (openTurnIn: FanoutDeps["openTurnIn"]) =>
    ({
      service: SESSION,
      runId: "run-1",
      token: "token-1",
      clock: () => new Date(0),
      deadlineAt: 60_000,
      leased: async <T>(fn: (tx: Queryable) => Promise<T>) => fn(q),
      deps: { openTurnIn },
    }) as unknown as FanoutCtx;

  it("opens the turn and writes its id in the same transaction", async () => {
    const writeId = vi.fn(async () => 1);
    const turn = await openLeasedTurn(
      ctx(async (_q, _s, input) => ({ turnId: input.turnId, traceId: "trace-1" }) as OpenedTurn),
      "Second opinion: order the week's drivers",
      writeId,
    );
    expect(turn?.opened.traceId).toBe("trace-1");
    expect(writeId).toHaveBeenCalledWith(q, turn?.turnId);
  });

  it("reads a unique violation as the gateway's busy refusal: no turn, so the caller gives its hold back", async () => {
    const writeId = vi.fn(async () => 1);
    const raced = ctx(async () => {
      throw new DbError("sql", "23505");
    });
    expect(await openLeasedTurn(raced, "Second opinion: compare the checks", writeId)).toBeNull();
    expect(writeId).not.toHaveBeenCalled();
  });

  it("still ends the slice on any other database error", async () => {
    for (const err of [new DbError("timeout"), new DbError("sql", "40001")]) {
      const failing = ctx(async () => {
        throw err;
      });
      await expect(openLeasedTurn(failing, "Second opinion: compare the checks", async () => 1)).rejects.toBe(err);
    }
  });
});

describe("the ordering and comparison calls' caps", () => {
  // The reserve the wrapper takes for a Wonder request: the body's bytes as input plus every output
  // token, at the Wonder price (src/lib/ai/index.ts textPlan, with no attachments and no search).
  const wonderReserveCents = (request: AiRequest, options: { maxOutputTokens: number; reasoningEffort: "low" | "medium" }) => {
    const body = JSON.stringify(metaBody("muse-wonder-1.0", request, options));
    const price = priceFor("wonder", "meta", "muse-wonder-1.0") as TokenPrice;
    return estimateReserve(price, new TextEncoder().encode(body).length, options.maxOutputTokens) / NANOCENTS_PER_CENT;
  };
  const id = (n: number) => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const window = { start: "2026-10-26", end: "2026-11-01" };

  it("leave reasoning room under each output cap, and the full-roster worst case fits each cost cap", () => {
    const l = fanoutLimits();
    expect(PLAN_CALL.maxOutputTokens).toBeGreaterThanOrEqual(l.maxDrivers * 100 * 2);
    expect(RECONCILE_CALL.maxOutputTokens).toBeGreaterThanOrEqual(4_000);
    const full: Roster = {
      rows: Array.from({ length: l.maxDrivers }, (_, n) => ({
        driverId: id(n),
        code: `D-${n}`,
        netCents: null,
        loads: 99,
        payItems: 99,
        advances: 99,
        days: 7,
        findings: Object.fromEntries(FINDING_CATEGORIES.map((c) => [c, 9])),
      })),
      skipped: Array.from({ length: 20 }, (_, n) => ({ driverId: id(1_000 + n), reason: "over_limit" as const })),
      payBases: ["per_mile", "percent", "flat"],
    };
    const plan: AiRequest = {
      purpose: "fanout_plan",
      messages: [
        { role: "system", content: PLAN_PROMPT },
        { role: "user", content: planInput(full, window) },
      ],
      format: PLAN_FORMAT,
    };
    expect(wonderReserveCents(plan, PLAN_CALL)).toBeLessThanOrEqual(l.planCents);

    const checks: CheckRow[] = full.rows.map((r) => ({
      driverId: r.driverId,
      status: "done",
      answer: {
        driverId: r.driverId,
        checkedAll: true,
        confidence: "low",
        issues: Array.from({ length: MAX_ISSUES }, () => ({
          category: OTHER_CATEGORY,
          sources: Array.from({ length: MAX_SOURCES }, (_, k) => ({ table: "deduction_schedules", id: id(k) })),
          note: "",
        })),
      },
    }));
    const engine: EngineFinding[] = Array.from({ length: flags.sweepLimits.maxItems }, (_, n) => ({
      driverId: id(n % l.maxDrivers),
      category: FINDING_CATEGORIES[0],
      table: "deduction_schedules",
      id: id(n),
    }));
    const reconcile: AiRequest = {
      purpose: "fanout_reconcile",
      messages: [
        { role: "system", content: RECONCILE_PROMPT },
        { role: "user", content: reconcileInput(computeCounts(engine, checks).counts, engine, checks) },
      ],
      format: RECONCILE_FORMAT,
    };
    expect(wonderReserveCents(reconcile, RECONCILE_CALL)).toBeLessThanOrEqual(l.reconcileCents);
    // Both, with every driver's check, fit the second opinion's share of the run's cap.
    expect(l.maxDrivers * l.driverCents + l.planCents + l.reconcileCents).toBeLessThanOrEqual(
      l.runCapCents - flags.sweepLimits.maxRunCents,
    );
  });

  it("start a Wonder call only with at least 20 s for it, inside the route's 30 s", () => {
    expect(MIN_WONDER_MS + 5_000).toBeGreaterThanOrEqual(20_000);
    expect(MIN_WONDER_MS).toBeLessThanOrEqual(flags.sweepLimits.sliceMs);
  });
});
