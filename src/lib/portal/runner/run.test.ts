import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import type { ComputerAction, ComputerCall, ComputerRequest, ComputerResult, ComputerScreenshot, SafetyCheck } from "../../ai";
import { PNG_BYTES } from "../../ai/test-fixtures";
import type { PortalRecord } from "./answer";
import type { CapturedPod, PortalCookie, PortalDriver } from "./driver";
import { taskText } from "./prompt";
import { runPortalRun, type RunDeps, type StepFn } from "./run";
import {
  LostClaimError,
  type Ending,
  type EvidenceRow,
  type HeldPod,
  type NewStep,
  type Progress,
  type RunRow,
  type RunStore,
  type StoredCheck,
  type StoredStep,
} from "./store";

const ORIGIN = "http://localhost:3000";
const TENANT = "11111111-1111-4111-8111-111111111111";
const REF = "FFE-100001";
const DETAIL = `${ORIGIN}/portal/loads/${REF}`;
const SHOT: ComputerScreenshot = { mime: "image/png", bytes: PNG_BYTES };
const POD_BYTES = new Uint8Array([...Buffer.from("%PDF-1.4 synthetic pod")]);
const POD_HASH = createHash("sha256").update(POD_BYTES).digest("hex");
const T0 = Date.parse("2026-10-27T15:00:00Z");
const CENT = 1_000_000_000;

// The portal's own record: 09:05 to 11:10 Central on Oct 20 (CDT, UTC-5).
const RECORD: PortalRecord = {
  checkedIn: "2026-10-20T14:05:00.000Z",
  checkedOut: "2026-10-20T16:10:00.000Z",
  zone: "America/Chicago",
  podContentHash: POD_HASH,
};
const ANSWER = {
  found: true,
  reference: REF,
  deliveryCheckedIn: "2026-10-20 09:05",
  deliveryCheckedOut: "2026-10-20 11:10",
  timeZoneLabel: "CT",
  podDownloaded: true,
  podSignedBy: "Dana Reyes",
  notes: "",
};

const LIMITS = { ...flags.portalRunLimits };

function runRow(extra: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    loadId: "load-1",
    reference: REF,
    requestedBy: "sub-1",
    turnId: null,
    traceId: "trace-1",
    model: "spark",
    stepCount: 0,
    modelCallCount: 0,
    costNanocents: 0,
    lastUrl: null,
    sessionId: null,
    resumeStep: null,
    ...extra,
  };
}

// A store that keeps everything in memory and logs every write in order.
function fakeStore(options: {
  run?: RunRow;
  member?: boolean;
  claim?: "claimed" | "not_queued" | "missing";
  steps?: StoredStep[];
  checks?: StoredCheck[];
  screenshots?: Map<number, ComputerScreenshot>;
  record?: PortalRecord | null;
  sessionState?: "alive" | "not_signed_in" | "expired";
  loseClaimOn?: string;
  // What the last pause left on the run, read back by a resume.
  heldPod?: HeldPod;
  // A hold that fails as the database would.
  holdFails?: boolean;
} = {}) {
  const log: string[] = [];
  const inserted: NewStep[] = [];
  const completed: { seq: number; urlAfter: string; stoppedEarly: boolean }[] = [];
  const paused: { stepId: string; checks: SafetyCheck[]; podHash: string | null }[] = [];
  const holds: { bytes: Uint8Array; stepSeq: number }[] = [];
  const finished: { ending: Ending; progress: Progress | null }[] = [];
  const evidence: { row: EvidenceRow; ending: Ending; progress: Progress }[] = [];
  const answers: string[] = [];
  const run = options.run ?? runRow();
  const lose = (what: string) => {
    if (options.loseClaimOn === what) throw new LostClaimError();
  };
  const store: RunStore = {
    async claim() {
      log.push("claim");
      const kind = options.claim ?? "claimed";
      return kind === "claimed" ? { kind, run, member: options.member ?? true } : { kind };
    },
    async context() {
      return { loadNumber: "L-2001", carrierNumber: "MC-123456" };
    },
    async mintSession() {
      log.push("mint");
      return { sessionId: "sess-1", code: "ABCD2345", expiresAt: new Date(T0 + 1_200_000).toISOString() };
    },
    async sessionState() {
      return options.sessionState ?? "alive";
    },
    async steps() {
      return options.steps ?? [];
    },
    async screenshot(_runId, seq) {
      return options.screenshots?.get(seq) ?? null;
    },
    async checks() {
      return options.checks ?? [];
    },
    async insertStep(_runId, _token, step) {
      lose("insertStep");
      log.push(`step ${step.seq} ${step.executed ? "executed" : "held"}`);
      inserted.push(step);
      return `step-${step.seq}`;
    },
    async completeStep(_runId, _token, seq, done) {
      log.push(`complete ${seq}`);
      completed.push({ seq, urlAfter: done.urlAfter, stoppedEarly: done.stoppedEarly });
    },
    async holdPod(_runId, _token, pod) {
      lose("holdPod");
      log.push(`hold ${pod.stepSeq}`);
      if (options.holdFails) throw Object.assign(new Error("db"), { name: "DbError" });
      holds.push(pod);
    },
    async heldPod() {
      log.push("held");
      return options.heldPod ?? { pausedHash: null, held: null };
    },
    async pause(_runId, _token, stepId, checks, _progress, podHash) {
      log.push(`pause ${stepId}`);
      paused.push({ stepId, checks, podHash });
    },
    async progress() {
      log.push("progress");
    },
    async finish(_runId, _token, ending, progress) {
      log.push(`finish ${ending.status} ${ending.reason}`);
      finished.push({ ending, progress });
    },
    async portalRecord() {
      return options.record === undefined ? RECORD : options.record;
    },
    async storeAnswer(text) {
      answers.push(text);
      return "input-1";
    },
    async finishWithEvidence(_runId, _token, _loadId, row, ending, progress) {
      log.push(`evidence ${ending.reason}`);
      evidence.push({ row, ending, progress });
    },
  };
  return { store, log, inserted, completed, paused, holds, finished, evidence, answers };
}

// A browser that runs nothing real. Each action may carry an effect: a new URL or a captured POD.
// Signing in lands on the loads page unless the portal is set to refuse it.
function fakeDriver(
  // pod: true captures this load's own POD; a string captures a POD from that URL instead.
  effects: Record<number, { url?: string; pod?: boolean | string; fail?: boolean }> = {},
  portal: { refuseSignIn?: boolean } = {},
) {
  const state = {
    ran: [] as ComputerAction[],
    opened: [] as { url: string; cookie: PortalCookie | null }[],
    signIns: [] as { url: string; carrierNumber: string; code: string }[],
    url: "about:blank",
    pod: null as CapturedPod | null,
    closed: false,
    shots: 0,
  };
  const driver: PortalDriver = {
    async open(url, cookie) {
      state.opened.push({ url, cookie });
      state.url = url;
    },
    async signIn(url, credentials) {
      state.signIns.push({ url, ...credentials });
      state.url = portal.refuseSignIn ? `${ORIGIN}/portal?t=${TENANT}&e=1` : `${ORIGIN}/portal/loads`;
    },
    async run(action) {
      const effect = effects[state.ran.length] ?? {};
      state.ran.push(action);
      if (effect.fail) throw new Error("element detached");
      if (effect.url) state.url = effect.url;
      if (effect.pod) state.pod = { bytes: POD_BYTES, url: effect.pod === true ? `${DETAIL}/pod` : effect.pod };
    },
    async settle() {},
    async screenshot() {
      state.shots += 1;
      return SHOT;
    },
    url: () => state.url,
    pod: () => state.pod,
    async close() {
      state.closed = true;
    },
  };
  return { driver, state };
}

let callN = 0;
function callResult(actions: Record<string, unknown>[], checks: SafetyCheck[] = [], cost = 2 * CENT): ComputerResult {
  callN += 1;
  const callId = `call_${callN}`;
  const raw = { type: "computer_call", call_id: callId, actions, pending_safety_checks: checks, status: "completed" };
  const call: ComputerCall = { callId, actions, pendingSafetyChecks: checks, checks, status: "completed", raw };
  return result({ call, cost });
}

function result(extra: { call?: ComputerCall | null; text?: string; status?: "ok" | "incomplete"; cost?: number }): ComputerResult {
  return {
    callId: `mc-${callN}-${Math.random()}`,
    status: extra.status ?? "ok",
    text: extra.text ?? "",
    toolCalls: [],
    usage: { input: 10, cached: 0, output: 10, reasoning: 0 },
    costNanocents: extra.cost ?? 2 * CENT,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    call: extra.call ?? null,
  };
}

const answerResult = (answer: Record<string, unknown> = ANSWER, cost = 2 * CENT) =>
  result({ text: JSON.stringify(answer), cost });

// A model that plays back a script, keeping a copy of every request as it was sent.
function scripted(results: (ComputerResult | Error)[]) {
  const requests: ComputerRequest[] = [];
  const targets: string[] = [];
  const step = vi.fn<StepFn>(async (target, request) => {
    targets.push(target);
    requests.push({ ...request, history: request.history.map((p) => ({ ...p, output: { ...p.output } })) });
    const next = results.shift();
    if (!next) throw new Error("script ran out");
    if (next instanceof Error) throw next;
    return next;
  });
  return { step, requests, targets };
}

function deps(
  store: RunStore,
  driver: PortalDriver,
  step: StepFn,
  extra: Partial<RunDeps> = {},
): RunDeps {
  let t = T0;
  return {
    store,
    openDriver: async () => driver,
    step,
    screen: async () => "clean",
    now: () => new Date((t += 1_000)),
    sleep: async () => undefined,
    origin: ORIGIN,
    recordDir: null,
    ...extra,
  };
}

const click = (x = 100, y = 200) => ({ type: "click", x, y, button: "left" });
const PAYLOAD = { tenantId: TENANT, runId: "run-1" };

beforeEach(() => {
  flags.portalRunnerEnabled = true;
  flags.portalRunLimits = { ...LIMITS };
  callN = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  flags.portalRunnerEnabled = false;
  flags.portalRunLimits = { ...LIMITS };
  vi.restoreAllMocks();
});

describe("runPortalRun, a run start to finish", () => {
  it("signs in, opens the load, downloads the POD and stores the evidence with a matching readback", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 1: { url: DETAIL }, 2: { pod: true } });
    const m = scripted([
      callResult([{ type: "type", text: REF }, { type: "keypress", keys: ["Enter"] }]),
      callResult([click()]),
      answerResult(),
    ]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));

    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    // The driver typed the code itself, before the first screenshot; nothing else opened a page.
    expect(d.state.signIns).toEqual([{ url: `${ORIGIN}/portal?t=${TENANT}`, carrierNumber: "MC-123456", code: "ABCD2345" }]);
    expect(d.state.opened).toEqual([]);
    expect(s.inserted[0].urlAfter).toBe(`${ORIGIN}/portal/loads`);
    expect(d.state.ran.map((a) => a.type)).toEqual(["type", "keypress", "click"]);
    expect(d.state.closed).toBe(true);
    expect(m.targets).toEqual(["spark", "spark", "spark"]);
    // Each call sees one more pair; nothing is ever acknowledged without a person.
    expect(m.requests.map((r) => r.history.length)).toEqual([0, 1, 2]);
    for (const r of m.requests) {
      for (const p of r.history) expect(p.output.acknowledged).toEqual([]);
    }
    // The code is in no request to the model and in no stored step, whatever the field.
    expect(m.requests[0].task).not.toContain("Access code");
    for (const r of m.requests) {
      expect(JSON.stringify({ task: r.task, instructions: r.instructions, history: r.history.map((h) => h.call) })).not.toContain(
        "ABCD2345",
      );
    }
    for (const step of s.inserted) {
      expect(JSON.stringify({ summary: step.summary, call: step.call, urlAfter: step.urlAfter })).not.toContain("ABCD2345");
    }
    expect(m.requests[0].maxCostCents).toBe(LIMITS.maxCallCents);
    // The typed text never reaches the trace: only its length.
    expect(s.inserted[1].summary).toEqual([{ type: "type", chars: REF.length }, { type: "keypress", keys: ["Enter"] }]);
    expect(s.log).toEqual([
      "claim",
      "mint",
      "step 0 executed",
      "step 1 executed",
      "progress",
      "step 2 executed",
      "progress",
      "step 3 held",
      "evidence ok",
    ]);
    const { row, ending, progress } = s.evidence[0];
    expect(row).toMatchObject({
      checkedIn: RECORD.checkedIn,
      checkedOut: RECORD.checkedOut,
      zone: "America/Chicago",
      timesStepSeq: 2,
      pod: { hash: POD_HASH, stepSeq: 2 },
      untrustedInputId: "input-1",
      screenVerdict: "clean",
      readback: "matches",
    });
    expect(ending).toEqual({ status: "done", reason: "ok", result: { readback: "matches", screen: "clean" } });
    expect(progress).toEqual({ costNanocents: 6 * CENT, modelCallCount: 3, stepCount: 3, lastUrl: DETAIL });
  });

  it("stores no POD when the browser captured none, and reads back partial", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { url: DETAIL } });
    const m = scripted([callResult([click()]), answerResult()]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    expect(s.evidence[0].row.pod).toBeNull();
    expect(s.evidence[0].row.readback).toBe("partial");
  });

  it.each([
    ["another load's POD", `${ORIGIN}/portal/loads/FFE-100002/pod`],
    ["a longer reference that starts with this one", `${ORIGIN}/portal/loads/${REF}0/pod`],
    ["a path past this load's POD", `${ORIGIN}/portal/loads/${REF}/pod/x`],
    ["this load's POD path on another origin", `http://localhost:3001/portal/loads/${REF}/pod`],
  ])("never stores %s as this load's POD, and counts it on the result", async (_name, url) => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { url: DETAIL }, 1: { pod: url } });
    const m = scripted([callResult([click()]), callResult([click()]), answerResult()]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    expect(s.evidence[0].row.pod).toBeNull();
    expect(s.evidence[0].row.readback).toBe("partial");
    expect(s.evidence[0].ending.result).toEqual({ readback: "partial", screen: "clean", ignoredPods: 1 });
  });

  it("keeps this load's own POD when another load's was opened first", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { url: DETAIL }, 1: { pod: `${ORIGIN}/portal/loads/FFE-100002/pod` }, 2: { pod: true } });
    const m = scripted([callResult([click()]), callResult([click()]), callResult([click()]), answerResult()]);
    await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(s.evidence[0].row.pod).toMatchObject({ hash: POD_HASH, stepSeq: 3 });
    expect(s.evidence[0].row.readback).toBe("matches");
    expect(s.evidence[0].ending.result).toEqual({ readback: "matches", screen: "clean", ignoredPods: 1 });
  });

  it("reads back differs when the answer's times are not the portal's", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { url: DETAIL }, 1: { pod: true } });
    const m = scripted([callResult([click()]), callResult([click()]), answerResult({ ...ANSWER, deliveryCheckedOut: "2026-10-20 11:50" })]);
    await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(s.evidence[0].row.readback).toBe("differs");
  });

  it("ends done with not_found when the portal has no such load", async () => {
    const s = fakeStore({ record: { checkedIn: null, checkedOut: null, zone: "America/Chicago", podContentHash: null } });
    const d = fakeDriver();
    const m = scripted([
      answerResult({ ...ANSWER, found: false, deliveryCheckedIn: null, deliveryCheckedOut: null, timeZoneLabel: null, podDownloaded: false, podSignedBy: null }),
    ]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "done", reason: "not_found" });
    expect(s.evidence[0].row).toMatchObject({ checkedIn: null, timesStepSeq: null, readback: "matches" });
  });

  it.each([
    ["an answer for another load", { ...ANSWER, reference: "FFE-999999" }],
    ["one time without the other", { ...ANSWER, deliveryCheckedOut: null }],
    ["times without a zone", { ...ANSWER, timeZoneLabel: null }],
    ["text around the JSON", "Here it is: {}"],
  ])("stores no evidence for %s", async (_name, answer) => {
    const s = fakeStore();
    const d = fakeDriver();
    const text = typeof answer === "string" ? answer : JSON.stringify(answer);
    const m = scripted([result({ text })]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "no_evidence" });
    expect(s.evidence).toHaveLength(0);
    expect(s.answers).toHaveLength(0);
  });

  it("fails the run when the screener errors, and stores no evidence", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([answerResult()]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step, { screen: async () => "error" }));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "screen_error" });
    expect(s.answers).toHaveLength(1);
    expect(s.evidence).toHaveLength(0);
  });

  it("keeps a flagged answer as evidence marked flagged", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { url: DETAIL }, 1: { pod: true } });
    const m = scripted([callResult([click()]), callResult([click()]), answerResult()]);
    await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step, { screen: async () => "flagged" }));
    expect(s.evidence[0].row.screenVerdict).toBe("flagged");
  });
});

describe("runPortalRun, safety checks", () => {
  const CHECK_A = { id: "sc_a", code: "malicious_instructions", message: "The page asks for something else." };
  const CHECK_B = { id: "sc_b", code: "irrelevant_domain", message: "Unexpected page." };

  it("pauses on any pending check before running a single action of that call", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([callResult([click(), click(5, 5)], [CHECK_A, CHECK_B])]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "paused" });
    expect(d.state.ran).toEqual([]);
    expect(s.paused).toEqual([{ stepId: "step-1", checks: [CHECK_A, CHECK_B], podHash: null }]);
    // No POD yet, so nothing is held.
    expect(s.holds).toEqual([]);
    expect(s.inserted[1]).toMatchObject({ seq: 1, executed: false, screenshot: null, pendingCheckCount: 2 });
    expect(s.finished).toHaveLength(0);
    expect(d.state.closed).toBe(true);
  });

  it("ends the run, running nothing, when a call carries more checks than a card holds", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `sc_${i}`, code: "unknown", message: "" }));
    const m = scripted([callResult([click()], many)]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "too_many_checks" });
    expect(d.state.ran).toEqual([]);
    expect(s.paused).toEqual([]);
  });

  // A run paused at step 2 on two checks, with step 1 behind it.
  function pausedRun(statuses: StoredCheck["status"][], createdAt = new Date(T0 - 60_000).toISOString()) {
    const step1 = { type: "computer_call", call_id: "call_s1", actions: [click()], pending_safety_checks: [] };
    const step2 = {
      type: "computer_call",
      call_id: "call_s2",
      actions: [click(300, 300), { type: "wait" }],
      pending_safety_checks: [CHECK_A, { ...CHECK_B, extra: "kept as received" }],
    };
    const steps: StoredStep[] = [
      { id: "step-0", seq: 0, callItem: null, upstreamCallId: null, executed: true, urlAfter: `${ORIGIN}/portal/loads`, pendingCheckCount: 0 },
      { id: "step-1", seq: 1, callItem: step1, upstreamCallId: "call_s1", executed: true, urlAfter: DETAIL, pendingCheckCount: 0 },
      { id: "step-2", seq: 2, callItem: step2, upstreamCallId: "call_s2", executed: false, urlAfter: null, pendingCheckCount: 2 },
    ];
    const checks: StoredCheck[] = [CHECK_A, CHECK_B].map((c, i) => ({
      id: `row-${i}`,
      stepId: "step-2",
      checkId: c.id,
      status: statuses[i],
      createdAt,
    }));
    const screenshots = new Map([
      [0, SHOT],
      [1, SHOT],
    ]);
    const run = runRow({ sessionId: "sess-1", resumeStep: 2, stepCount: 2, modelCallCount: 2, costNanocents: 4 * CENT, lastUrl: DETAIL });
    return { steps, checks, screenshots, run, step2 };
  }

  it("on resume runs the approved step, then acknowledges exactly the checks a person approved", async () => {
    const p = pausedRun(["approved", "approved"]);
    const s = fakeStore(p);
    const d = fakeDriver({ 1: { pod: true } });
    const m = scripted([answerResult()]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));

    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    expect(s.log).not.toContain("mint");
    expect(d.state.opened).toEqual([{ url: DETAIL, cookie: { name: "ll_portal", value: `${TENANT}.sess-1` } }]);
    expect(d.state.ran.map((a) => a.type)).toEqual(["click", "wait"]);
    expect(s.completed).toEqual([{ seq: 2, urlAfter: DETAIL, stoppedEarly: false }]);
    const sent = m.requests[0];
    // A resumed run signs in by its cookie, never by a code, and sends the same task text.
    expect(d.state.signIns).toEqual([]);
    expect(sent.task).toBe(
      taskText({ loadNumber: "L-2001", reference: REF, portalUrl: `${ORIGIN}/portal` }),
    );
    expect(sent.history.map((h) => h.output.callId)).toEqual(["call_s1", "call_s2"]);
    expect(sent.history[0].output.acknowledged).toEqual([]);
    // The raw check objects of that step, exactly as received, and nothing else.
    expect(sent.history[1].output.acknowledged).toEqual(p.step2.pending_safety_checks);
    expect(s.evidence[0].row.pod).toMatchObject({ stepSeq: 2 });
  });

  it.each([
    ["a check still pending", ["approved", "pending"]],
    ["a declined check", ["approved", "declined"]],
    ["an expired check", ["expired", "approved"]],
  ] as const)("does not resume with %s, and runs nothing", async (_name, statuses) => {
    const s = fakeStore(pausedRun([...statuses]));
    const d = fakeDriver();
    const m = scripted([]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "not_resumable" });
    expect(d.state.ran).toEqual([]);
    expect(m.step).not.toHaveBeenCalled();
  });

  it("stops a run whose approval came after the wait limit, running nothing", async () => {
    const s = fakeStore(pausedRun(["approved", "approved"], new Date(T0 - 31 * 60_000).toISOString()));
    const d = fakeDriver();
    const m = scripted([]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "stopped", reason: "approval_expired" });
    expect(d.state.ran).toEqual([]);
  });

  it("does not resume when the portal session has ended", async () => {
    const s = fakeStore({ ...pausedRun(["approved", "approved"]), sessionState: "expired" });
    const d = fakeDriver();
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, scripted([]).step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "session_expired" });
    expect(d.state.opened).toEqual([]);
  });

  // A first pass that opens the load, downloads its POD at step 2, then pauses at step 3 on a check.
  async function podThenPause(store: Parameters<typeof fakeStore>[0] = {}) {
    const s = fakeStore(store);
    const d = fakeDriver({ 0: { url: DETAIL }, 1: { pod: true } });
    const m = scripted([callResult([click()]), callResult([click(120, 220)]), callResult([click(5, 5)], [CHECK_A])]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    return { s, d, out };
  }

  // The store a resume reads, built from what a first pass wrote, with its checks approved.
  function resumeOf(first: ReturnType<typeof fakeStore>, heldPod: HeldPod) {
    const pause = first.paused[0];
    const pausedSeq = first.inserted.find((st) => `step-${st.seq}` === pause.stepId)!.seq;
    const steps: StoredStep[] = first.inserted.map((st) => ({
      id: `step-${st.seq}`,
      seq: st.seq,
      callItem: st.call ? st.call.raw : null,
      upstreamCallId: st.call ? st.call.callId : null,
      executed: st.executed,
      urlAfter: st.urlAfter,
      pendingCheckCount: st.pendingCheckCount,
    }));
    const checks: StoredCheck[] = pause.checks.map((c) => ({
      id: `row-${c.id}`,
      stepId: pause.stepId,
      checkId: c.id,
      status: "approved",
      createdAt: new Date(T0 - 60_000).toISOString(),
    }));
    const screenshots = new Map(first.inserted.filter((st) => st.screenshot).map((st) => [st.seq, st.screenshot!] as const));
    const run = runRow({
      sessionId: "sess-1",
      resumeStep: pausedSeq,
      stepCount: first.inserted.length - 1,
      modelCallCount: first.inserted.length - 1,
      costNanocents: (first.inserted.length - 1) * 2 * CENT,
      lastUrl: DETAIL,
    });
    return { run, steps, checks, screenshots, heldPod, pausedSeq };
  }

  it("keeps a POD captured before a pause through the resume, and stores it once with its hash", async () => {
    const first = await podThenPause();
    expect(first.out).toEqual({ kind: "paused" });
    // Held in its own write before the pause, which records the POD's hash.
    expect(first.s.log.slice(-2)).toEqual(["hold 2", "pause step-3"]);
    expect(first.s.holds).toHaveLength(1);
    expect(first.s.holds[0].stepSeq).toBe(2);
    expect(Buffer.from(first.s.holds[0].bytes).equals(Buffer.from(POD_BYTES))).toBe(true);
    expect(first.s.paused[0].podHash).toBe(POD_HASH);

    // The resume's approved click and its answer download nothing.
    const r = resumeOf(first.s, { pausedHash: first.s.paused[0].podHash, held: first.s.holds[0] });
    const s = fakeStore(r);
    const d = fakeDriver();
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, scripted([answerResult()]).step));

    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    expect(d.state.pod).toBeNull();
    expect(s.completed.map((c) => c.seq)).toEqual([r.pausedSeq]);
    expect(s.evidence).toHaveLength(1);
    const { row, ending } = s.evidence[0];
    expect(row.pod).not.toBeNull();
    expect(row.pod!.hash).toBe(POD_HASH);
    expect(row.pod!.stepSeq).toBe(2);
    expect(Buffer.from(row.pod!.bytes).equals(Buffer.from(POD_BYTES))).toBe(true);
    expect(row.readback).toBe("matches");
    expect(ending).toEqual({ status: "done", reason: "ok", result: { readback: "matches", screen: "clean" } });
    expect(s.finished).toHaveLength(0);
  });

  it.each([
    ["a hold the database refuses", { holdFails: true }, ["hold 2", "pause step-3"]],
    ["a POD over the cap, never sent", { podMaxBytes: POD_BYTES.length - 1 }, ["pause step-3"]],
  ] as const)("still pauses after %s, and a resume without that POD ends storing nothing", async (_name, how, tail) => {
    if ("podMaxBytes" in how) flags.portalRunLimits = { ...LIMITS, podMaxBytes: how.podMaxBytes };
    const first = await podThenPause("holdFails" in how ? { holdFails: true } : {});
    // The run is not lost: it waits for a person, and the pause still names the POD it had.
    expect(first.out).toEqual({ kind: "paused" });
    expect(first.s.log.slice(-2).filter((l) => l.startsWith("hold") || l.startsWith("pause"))).toEqual([...tail]);
    expect(first.s.holds).toEqual([]);
    expect(first.s.paused[0].podHash).toBe(POD_HASH);
    expect(first.s.finished).toHaveLength(0);

    flags.portalRunLimits = { ...LIMITS };
    const s = fakeStore(resumeOf(first.s, { pausedHash: POD_HASH, held: null }));
    const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, scripted([answerResult()]).step));
    // Unknown is not zero: no evidence that says no POD, and no POD claimed.
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "pod_not_kept" });
    expect(s.evidence).toEqual([]);
    expect(s.answers).toEqual([]);
    expect(s.finished.map((f) => f.ending.reason)).toEqual(["pod_not_kept"]);
  });

  it("takes held bytes only when they hash to the POD the run paused with", async () => {
    const first = await podThenPause();
    const other = new Uint8Array([...Buffer.from("%PDF-1.4 another pod")]);
    const s = fakeStore(resumeOf(first.s, { pausedHash: POD_HASH, held: { bytes: other, stepSeq: 2 } }));
    const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, scripted([answerResult()]).step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "pod_not_kept" });
    expect(s.evidence).toEqual([]);
  });

  it("stores the POD a resumed run downloads again when the earlier one was not held", async () => {
    const first = await podThenPause({ holdFails: true });
    const r = resumeOf(first.s, { pausedHash: POD_HASH, held: null });
    const s = fakeStore(r);
    const d = fakeDriver({ 0: { pod: true } });
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, scripted([answerResult()]).step));
    expect(out).toEqual({ kind: "ended", status: "done", reason: "ok" });
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0].row.pod).toMatchObject({ hash: POD_HASH, stepSeq: r.pausedSeq });
  });

  it("names a POD it no longer holds at its next pause, so a later resume still knows", async () => {
    const first = await podThenPause({ holdFails: true });
    const s = fakeStore(resumeOf(first.s, { pausedHash: POD_HASH, held: null }));
    const out = await runPortalRun(
      PAYLOAD,
      deps(s.store, fakeDriver().driver, scripted([callResult([click()], [CHECK_B])]).step),
    );
    expect(out).toEqual({ kind: "paused" });
    expect(s.holds).toEqual([]);
    expect(s.paused.map((p) => p.podHash)).toEqual([POD_HASH]);
  });

  it("writes nothing more when the claim is lost while holding the POD", async () => {
    const first = await podThenPause({ loseClaimOn: "holdPod" });
    expect(first.out).toEqual({ kind: "lost" });
    expect(first.s.paused).toEqual([]);
    expect(first.s.finished).toEqual([]);
  });
});

describe("runPortalRun, guards and caps", () => {
  it("refuses a batch with any invalid action whole: nothing in it runs", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([callResult([click(), { type: "click", x: 99_999, y: 5, button: "left" }])]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "invalid_action" });
    expect(d.state.ran).toEqual([]);
    expect(s.inserted[1]).toMatchObject({ executed: false });
    expect(s.finished[0].ending.result).toEqual({ detail: "invalid_action" });
  });

  it("refuses an action type the runner does not know, and a batch over the action cap", async () => {
    for (const actions of [[{ type: "navigate", url: "https://example.test" }], Array.from({ length: 9 }, () => click())]) {
      const s = fakeStore();
      const d = fakeDriver();
      const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, scripted([callResult(actions)]).step));
      expect(out).toMatchObject({ kind: "ended", status: "failed", reason: "invalid_action" });
      expect(d.state.ran).toEqual([]);
    }
  });

  it("stops a batch at the first browser error and carries on from the screen it left", async () => {
    const s = fakeStore();
    const d = fakeDriver({ 0: { fail: true } });
    const m = scripted([callResult([click(), click(1, 1)]), callResult([click(2, 2)]), result({ status: "incomplete" }), result({ status: "incomplete" })]);
    await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(d.state.ran).toEqual([click(), click(2, 2)]);
    expect(s.inserted[1]).toMatchObject({ executed: true, stoppedEarly: true });
    expect(s.inserted[2]).toMatchObject({ executed: true, stoppedEarly: false });
  });

  it("ends at the step budget before the call that would pass it", async () => {
    flags.portalRunLimits = { ...LIMITS, maxSteps: 2 };
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([callResult([click()]), callResult([click()]), callResult([click()])]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "step_budget" });
    expect(m.step).toHaveBeenCalledTimes(2);
  });

  it("ends at the wall-clock limit", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    // Each model call takes 100 seconds; the limit is 240.
    let t = T0;
    const m = scripted([callResult([click()]), callResult([click()]), callResult([click()]), callResult([click()])]);
    const slow: StepFn = async (...args) => {
      t += 100_000;
      return m.step(...args);
    };
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, slow, { now: () => new Date(t) }));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "wall_time" });
    expect(m.step).toHaveBeenCalledTimes(3);
  });

  it("asks each call for no more than the run has left, and ends when it has less than a cent", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([callResult([click()], [], 65 * CENT), callResult([click()], [], 65 * CENT), callResult([click()], [], 65 * CENT)]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(m.requests.map((r) => r.maxCostCents)).toEqual([25, 25, 20]);
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "run_cents" });
    expect(s.finished[0].progress).toMatchObject({ costNanocents: 195 * CENT, modelCallCount: 3 });
  });

  it("names a refused call by the cap it hit", async () => {
    const tooExpensive = Object.assign(new Error("too_expensive"), { name: "AiError", category: "too_expensive" });
    const capped = Object.assign(new Error("cap"), { name: "AiError", category: "cap" });
    for (const [err, reason] of [[tooExpensive, "call_cents"], [capped, "spend_cap"]] as const) {
      const s = fakeStore();
      const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, scripted([err]).step));
      expect(out).toEqual({ kind: "ended", status: "failed", reason });
    }
  });

  it("retries an out-of-budget answer once with a larger budget, from the same state", async () => {
    const s = fakeStore();
    const d = fakeDriver();
    const m = scripted([result({ status: "incomplete" }), answerResult({ ...ANSWER, found: false, deliveryCheckedIn: null, deliveryCheckedOut: null, timeZoneLabel: null })]);
    await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(m.requests.map((r) => r.maxOutputTokens)).toEqual([1024, 2048]);
    expect(m.requests[1].history).toEqual(m.requests[0].history);
  });

  it("ends after a second out-of-budget answer in a row", async () => {
    const s = fakeStore();
    const m = scripted([result({ status: "incomplete" }), result({ status: "incomplete" })]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "incomplete" });
    expect(s.finished[0].progress).toMatchObject({ modelCallCount: 2 });
  });

  it("re-checks the switch when it claims a run, and opens nothing when it is off", async () => {
    flags.portalRunnerEnabled = false;
    const s = fakeStore();
    const d = fakeDriver();
    const opened = vi.fn(async () => d.driver);
    const m = scripted([]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step, { openDriver: opened }));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "disabled" });
    expect(opened).not.toHaveBeenCalled();
    expect(m.step).not.toHaveBeenCalled();
  });

  it("fails a run whose requester is no longer a member", async () => {
    const s = fakeStore({ member: false });
    const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, scripted([]).step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "forbidden" });
  });

  it("skips a run another worker holds, and retries a run not yet visible", async () => {
    const held = fakeStore({ claim: "not_queued" });
    expect(await runPortalRun(PAYLOAD, deps(held.store, fakeDriver().driver, scripted([]).step))).toEqual({ kind: "skipped" });
    expect(held.log).toEqual(["claim"]);
    const missing = fakeStore({ claim: "missing" });
    const sleep = vi.fn(async () => undefined);
    expect(await runPortalRun(PAYLOAD, deps(missing.store, fakeDriver().driver, scripted([]).step, { sleep }))).toEqual({ kind: "skipped" });
    expect(missing.log).toHaveLength(10);
    expect(sleep).toHaveBeenCalledTimes(9);
  });

  it("ends with a browser error when the portal cannot be opened, and closes nothing it did not open", async () => {
    const s = fakeStore();
    const out = await runPortalRun(
      PAYLOAD,
      deps(s.store, fakeDriver().driver, scripted([]).step, {
        openDriver: async () => {
          throw new Error("launch failed");
        },
      }),
    );
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "browser_error" });
  });

  it("ends without a model call or a screenshot when the portal refuses the sign-in", async () => {
    const s = fakeStore();
    const d = fakeDriver({}, { refuseSignIn: true });
    const m = scripted([]);
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, m.step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "sign_in_failed" });
    expect(d.state.signIns).toHaveLength(1);
    expect(d.state.shots).toBe(0);
    expect(s.inserted).toEqual([]);
    expect(m.step).not.toHaveBeenCalled();
    expect(d.state.closed).toBe(true);
  });

  it("writes nothing more once its claim is lost", async () => {
    const s = fakeStore({ loseClaimOn: "insertStep" });
    const d = fakeDriver();
    const out = await runPortalRun(PAYLOAD, deps(s.store, d.driver, scripted([]).step));
    expect(out).toEqual({ kind: "lost" });
    expect(s.finished).toHaveLength(0);
    expect(d.state.closed).toBe(true);
  });

  it("ends when a screenshot is over its size cap", async () => {
    flags.portalRunLimits = { ...LIMITS, screenshotMaxBytes: 4 };
    const s = fakeStore();
    const out = await runPortalRun(PAYLOAD, deps(s.store, fakeDriver().driver, scripted([]).step));
    expect(out).toEqual({ kind: "ended", status: "failed", reason: "screenshot_too_large" });
  });
});
