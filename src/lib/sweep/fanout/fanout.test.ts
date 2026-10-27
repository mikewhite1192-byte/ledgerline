import { describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { StepFinish, StepStart } from "@/lib/agent/gateway/store/types";
import type { StepView } from "@/lib/agent/view";
import type { GatewayOutcome } from "@/lib/agent/gateway/types";
import { AiError, type AiRequest, type AiResult, type AiTool } from "@/lib/ai";
import { NANOCENTS_PER_CENT } from "@/lib/ai/prices";
import { CHECK_TOOLS, runChildCheck, sourcesFrom, validateCheck, type ChildDeps, type ChildInput } from "./check";
import { refusedByProvider } from "./limits";
import { defaultOrder, validatePlan, type Roster } from "./plan";
import { computeCounts, fanoutFindingKey, validateReconcile, type CheckRow, type EngineFinding } from "./reconcile";
import { parseJson, scrubFigures } from "./schemas";
import { treeOf, type FanoutCheckRow, type FanoutRow } from "./tree";

// The second opinion's server rules, without a database or a model: the plan, check and
// comparison validators, the child loop's caps on a fake clock and a fake model, and the page
// tree's figure guard.

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

// ---- The child loop on a fake clock and a fake model ----

const LIMITS = { ...flags.fanoutLimits };
const SESSION = { sub: "service:sweep:t", email: "sweep@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const TOOLS: AiTool[] = [...CHECK_TOOLS, "propose_pay_correction"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
}));

function input(over: Partial<ChildInput> = {}): ChildInput {
  return {
    session: SESSION,
    turnId: "turn-1",
    traceId: "trace-1",
    timeZone: "America/Chicago",
    driverId: A,
    week: { start: "2026-10-26", end: "2026-11-01" },
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

const toolCall = (name: string, driverId = A, n = 0) => ({ id: `tc-${name}-${n}`, name, argumentsJson: JSON.stringify({ driverId }) });

function harness(answers: ((req: AiRequest) => AiResult | Promise<AiResult>)[], opts: { stepMs?: number } = {}) {
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
  const callTool = vi.fn(
    async (_ctx: unknown, call: { name: string }): Promise<GatewayOutcome> => ({
      decision: "allowed",
      decisionId: `d-${call.name}`,
      tool: call.name,
      tier: "read",
      reason: "ok",
      result: { rows: [{ id: LOAD }] },
      refs: [],
      latencyMs: 1,
    }) as GatewayOutcome,
  );
  let step = 0;
  const steps = {
    startStep: vi.fn<(turnId: string, s: StepStart) => Promise<StepView>>(async () => ({ id: `s${++step}` }) as StepView),
    finishStep: vi.fn<(turnId: string, id: string, f: StepFinish) => Promise<StepView>>(async () => ({}) as StepView),
  };
  const deps: ChildDeps = {
    complete: complete as unknown as ChildDeps["complete"],
    callTool: callTool as unknown as ChildDeps["callTool"],
    steps,
    tools: TOOLS,
    clock: () => now,
    switchOn: () => true,
  };
  return { deps, complete, callTool, steps, requests };
}

const answer = (issues: unknown[] = []) =>
  result({ text: JSON.stringify({ driverId: A, checkedAll: true, confidence: "high", issues }) });

describe("runChildCheck", () => {
  it("reads, then answers with only the records it read; it is offered the five reads only", async () => {
    const h = harness([
      () => result({ toolCalls: [toolCall("get_loads")] }),
      () => answer([{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD }], note: "A day with no load." }]),
    ]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(out.answer?.issues).toEqual([{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD }], note: "A day with no load." }]);
    expect(out.modelCalls).toBe(2);
    expect(out.toolSteps).toBe(1);
    expect(h.requests[0].tools?.map((t) => t.name)).toEqual([...CHECK_TOOLS]);
    expect(h.requests.every((r) => r.purpose === "fanout_check" && (r.maxCostCents ?? Infinity) <= LIMITS.callCents)).toBe(true);
  });

  it("stops at three model calls: tool calls on the third end it unanswered, never run", async () => {
    const h = harness([() => result({ toolCalls: [toolCall("get_loads")] })]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("unparsed");
    expect(h.complete).toHaveBeenCalledTimes(LIMITS.maxCallsPerDriver);
    expect(h.callTool).toHaveBeenCalledTimes(LIMITS.maxCallsPerDriver - 1);
  });

  it("runs at most four tool steps, then asks for the answer", async () => {
    const three = () => result({ toolCalls: [0, 1, 2].map((n) => toolCall("get_loads", A, n)) });
    const h = harness([three, three, () => answer()]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(h.callTool).toHaveBeenCalledTimes(LIMITS.maxToolSteps);
    expect(out.toolSteps).toBe(LIMITS.maxToolSteps);
    const last = h.requests[2].messages.at(-1);
    expect(last?.role).toBe("system");
  });

  it("stops at the driver's cents", async () => {
    const h = harness([() => result({ toolCalls: [toolCall("get_loads")], costNanocents: 5 * NANOCENTS_PER_CENT })]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("budget");
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(out.costNanocents).toBe(10 * NANOCENTS_PER_CENT);
  });

  it("stops at fifteen seconds on the clock and never asks for longer than is left", async () => {
    const h = harness([() => result({ toolCalls: [toolCall("get_loads")] })], { stepMs: 6_000 });
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("timed_out");
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.requests[0].timeoutMs).toBeLessThanOrEqual(LIMITS.childTimeoutMs);
    expect(h.requests[1].timeoutMs).toBeLessThanOrEqual(LIMITS.childTimeoutMs - 6_000);
  });

  it("refuses a write tool and another driver's records without asking the gateway", async () => {
    const h = harness([
      () => result({ toolCalls: [toolCall("propose_pay_correction"), toolCall("get_loads", B)] }),
      () => answer(),
    ]);
    const out = await runChildCheck(input(), h.deps);
    expect(out.status).toBe("done");
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.steps.finishStep.mock.calls.filter((c) => c[2].state === "failed")).toHaveLength(2);
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

  it("makes no call when the switch is off", async () => {
    const h = harness([() => answer()]);
    const out = await runChildCheck(input(), { ...h.deps, switchOn: () => false });
    expect(out.status).toBe("error");
    expect(h.complete).not.toHaveBeenCalled();
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
