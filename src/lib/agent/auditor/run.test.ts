import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import type { AuditState, AuditStore, VerdictWrite } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import { AUDITOR_NOTES_RULE, AUDITOR_PROMPT } from "./policy";
import { AiError, runAudit, runEngineCheck, type AuditDeps, type AuditResult } from "./run";

// runAudit with a fake store, a fake gateway and a fake model (design 4.2 step 4): one Wonder call
// per proposal, the 90-second lease, the verdict written once, and the evidence never carrying
// outside text.

type AiResult = Awaited<ReturnType<CompleteFn>>;

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const PROPOSAL = "6a1f0c2e-9d3b-4c5a-8e7f-1b2c3d4e5f60";
const TURN = "7b2a1d3f-0e4c-4d6b-9f8a-2c3d4e5f6a71";
const NOW = new Date("2026-10-28T15:00:00.000Z");
const ENV = { META_MODEL_WONDER: "muse-wonder-1.0" };

const checks = (failed: string[] = []) =>
  ["cause", "sources", "amount", "limit"].map((name) => ({ name, pass: !failed.includes(name), note: "n" }));
const verdictText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "pass", concerns: [], checks: checks(), ...over });

const PACK = {
  proposal: { id: PROPOSAL, kind: "advance_payout", amountCents: 10_000, reasons: ["driver_asked"] },
  engine: { ok: true, check: "advance_eligibility", approvedCents: 10_000 },
};

function fakeStore(over: Partial<AuditState> = {}, missing = false, attempts = 0) {
  const state: AuditState = {
    id: PROPOSAL,
    status: "proposed",
    turnId: TURN,
    createdAt: "2026-10-28T14:00:00.000Z",
    verdict: null,
    concerns: [],
    checkedAt: null,
    startedAt: null,
    traceId: null,
    timeZone: "America/New_York",
    ...over,
  };
  const log = { leases: 0, releases: 0, attempts, writes: [] as VerdictWrite[], engineChecks: [] as string[], order: [] as string[] };
  const store: AuditStore = {
    read: async () => (missing ? null : { ...state, concerns: [...state.concerns] }),
    lease: async (_id, now, ms, trace) => {
      if (state.verdict !== null || state.status !== "proposed") return null;
      if (state.startedAt !== null && Date.parse(state.startedAt) > now.getTime() - ms) return null;
      log.leases += 1;
      log.attempts += 1;
      state.startedAt = now.toISOString();
      state.traceId ??= trace;
      return { traceId: state.traceId, attempts: log.attempts };
    },
    release: async (_id, startedAt) => {
      log.releases += 1;
      if (state.startedAt === startedAt.toISOString()) state.startedAt = null;
    },
    // As the database: only a waiting proposal with no verdict takes one, from the lease holder.
    write: async (_id, v, now, startedAt) => {
      if (state.verdict !== null || state.status !== "proposed") return false;
      if (state.startedAt !== startedAt.toISOString()) return false;
      log.writes.push(v);
      log.order.push("verdict");
      state.verdict = v.verdict;
      state.concerns = [...v.concerns];
      state.checkedAt = now.toISOString();
      return true;
    },
    // The code-side engine check: recorded with the trace it ran under, in call order.
    checkEngine: async (_id, ctx) => {
      log.engineChecks.push(ctx.traceId);
      log.order.push("engine");
      return true;
    },
  };
  return { state, store, log };
}

function allowed(result: Record<string, unknown> = PACK): GatewayOutcome {
  return { decision: "allowed", decisionId: "d-1", tool: "get_proposal", tier: "read", reason: "ok", result, refs: [], latencyMs: 2 };
}

function fakeTool(outcome: GatewayOutcome = allowed()) {
  const calls: { ctx: GatewayContext; call: ToolCall }[] = [];
  const fn = async (ctx: GatewayContext, call: ToolCall) => {
    calls.push({ ctx, call });
    return outcome;
  };
  return { fn, calls };
}

function okResult(text: string, status: AiResult["status"] = "ok"): AiResult {
  return {
    callId: "c0ffee00-0000-4000-8000-000000000001",
    status,
    text,
    toolCalls: [],
    usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 300, reasoningTokens: 200 },
    costNanocents: 960_000_000,
    upstreamId: "resp_1",
    replay: [],
  } as unknown as AiResult;
}

function fakeModel(answer: () => AiResult | Promise<AiResult>) {
  const fn = vi.fn<CompleteFn>(async () => answer());
  return fn;
}

function deps(over: Partial<AuditDeps> & { store: AuditStore }): AuditDeps {
  return { clock: () => NOW, env: ENV, callTool: fakeTool().fn, complete: fakeModel(() => okResult(verdictText())), ...over };
}

beforeEach(() => {
  flags.auditorEnabled = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.auditorEnabled = false;
  vi.restoreAllMocks();
});

describe("runAudit", () => {
  it("is off while the switch is off, with no read at all", async () => {
    flags.auditorEnabled = false;
    const read = vi.fn();
    const out = await runAudit(SESSION, PROPOSAL, { store: { read } as unknown as AuditStore });
    expect(out).toEqual({ state: "disabled" });
    expect(read).not.toHaveBeenCalled();
  });

  it("writes pass with agrees true, from one Wonder call over the gateway's pack", async () => {
    const { store, log } = fakeStore();
    const tool = fakeTool();
    const model = fakeModel(() => okResult(verdictText()));
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, callTool: tool.fn, complete: model }));
    expect(out).toEqual({ state: "done", verdict: "pass", concerns: [], checkedAt: NOW.toISOString() });
    expect(log.writes).toEqual([
      { verdict: "pass", agrees: true, callId: "c0ffee00-0000-4000-8000-000000000001", concerns: [] },
    ]);
    expect(model).toHaveBeenCalledTimes(1);
    const [target, request] = model.mock.calls[0];
    expect(target).toBe("wonder");
    expect(request).toMatchObject({
      purpose: "audit_proposal",
      reasoningEffort: "high",
      maxOutputTokens: 2_400,
      maxCostCents: 10,
      timeoutMs: 25_000,
      format: { name: "audit_verdict", strict: true },
    });
    expect(JSON.parse(request.messages[1].content as string)).toEqual(PACK);
    // The evidence came through the gateway, as the auditor, on the audit's own trace.
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].call).toMatchObject({ name: "get_proposal", argumentsJson: JSON.stringify({ proposalId: PROPOSAL }) });
    expect(tool.calls[0].ctx).toMatchObject({ role: "auditor", model: "wonder", turnId: TURN, deadlineAt: NOW.getTime() + 8_000 });
    expect(request.traceId).toBe(tool.calls[0].ctx.traceId);
  });

  it.each([
    ["concerns", ["source_missing"]],
    ["block", ["amount_wrong", "record_mismatch"]],
  ])("writes %s with agrees false and its concerns", async (verdict, concerns) => {
    const { store, log } = fakeStore();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => okResult(verdictText({ verdict, concerns }))) }));
    expect(out).toMatchObject({ state: "done", verdict, concerns });
    expect(log.writes[0]).toMatchObject({ verdict, agrees: false, concerns });
  });

  it("turns a pass with a failed check into concerns", async () => {
    const { store, log } = fakeStore();
    await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => okResult(verdictText({ checks: checks(["limit"]) }))) }));
    expect(log.writes[0]).toMatchObject({ verdict: "concerns", agrees: false, concerns: ["limit_exceeded"] });
  });

  it("turns a block with no concern or bad JSON into unknown", async () => {
    for (const result of [okResult(verdictText({ verdict: "block" })), okResult("not json")]) {
      const { store, log } = fakeStore();
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => result) }));
      expect(out).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
      expect(log.writes[0]).toMatchObject({ verdict: "unknown", agrees: null, concerns: ["insufficient_evidence"] });
    }
  });

  it.each(["cap", "too_expensive", "billing"] as const)("writes unknown with the budget concern on a %s refusal", async (category) => {
    const { store, log } = fakeStore();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => Promise.reject(new AiError(category))) }));
    expect(out).toMatchObject({ state: "done", verdict: "unknown", concerns: ["budget"] });
    expect(log.writes[0]).toEqual({ verdict: "unknown", agrees: null, callId: null, concerns: ["budget"] });
  });

  it.each(["network", "timeout", "unknown"] as const)("gives the lease back on %s and stores nothing", async (category) => {
    const { store, log, state } = fakeStore();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => Promise.reject(new AiError(category))) }));
    expect(out).toEqual({ state: "in_progress" });
    expect(log.writes).toEqual([]);
    expect(log.releases).toBe(1);
    expect(state.startedAt).toBeNull();
    // The retry keeps the first trace.
    const first = state.traceId;
    const model = fakeModel(() => okResult(verdictText()));
    await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(model.mock.calls[0][1].traceId).toBe(first);
  });

  it.each([
    ["rate_limited", 429],
    ["unavailable", 503],
  ] as const)("gives the lease back when Meta is busy (%s, %i) and stores nothing", async (category, status) => {
    const { store, log, state } = fakeStore();
    const model = fakeModel(() => Promise.reject(new AiError(category, status)));
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(out).toEqual({ state: "in_progress" });
    expect(model).toHaveBeenCalledTimes(1);
    expect(log.writes).toEqual([]);
    expect(log.releases).toBe(1);
    expect(state).toMatchObject({ verdict: null, startedAt: null });
  });

  it("gives the lease back on an answer cut short at the output budget, and stores nothing", async () => {
    for (const text of ["", '{"verdict":"pass","concerns":[],"chec']) {
      const { store, log, state } = fakeStore();
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => okResult(text, "incomplete")) }));
      expect(out, text).toEqual({ state: "in_progress" });
      expect(log.writes, text).toEqual([]);
      expect(log.releases, text).toBe(1);
      expect(state, text).toMatchObject({ verdict: null, startedAt: null });
    }
  });

  it("stores unknown on the third failed attempt instead of giving the lease back, and a fourth load makes no call", async () => {
    const { store, log, state } = fakeStore();
    const answers: (() => AiResult | Promise<AiResult>)[] = [
      () => Promise.reject(new AiError("timeout")),
      () => okResult('{"verdict":"pass","concerns":[],"chec', "incomplete"),
      () => Promise.reject(new AiError("unavailable", 503)),
    ];
    const model = fakeModel(() => answers[model.mock.calls.length - 1]());
    for (const n of [1, 2]) {
      expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: model })), `attempt ${n}`).toEqual({ state: "in_progress" });
    }
    expect(log.releases).toBe(2);
    expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }))).toEqual({
      state: "done",
      verdict: "unknown",
      concerns: ["insufficient_evidence"],
      checkedAt: NOW.toISOString(),
    });
    expect(model).toHaveBeenCalledTimes(3);
    expect(log.releases).toBe(2);
    expect(log.writes).toEqual([{ verdict: "unknown", agrees: null, callId: null, concerns: ["insufficient_evidence"] }]);
    expect(state.startedAt).toBe(NOW.toISOString());

    // A fourth page load reads the stored verdict back: no lease, no evidence read, no call.
    const tool = fakeTool();
    expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: tool.fn }))).toMatchObject({
      state: "done",
      verdict: "unknown",
    });
    expect(model).toHaveBeenCalledTimes(3);
    expect(tool.calls).toHaveLength(0);
    expect(log.leases).toBe(3);
  });

  it("stores unknown on every outcome that would give the lease back, once it is the third attempt", async () => {
    const failed: GatewayOutcome = {
      decision: "failed",
      decisionId: "d-3",
      tool: "get_proposal",
      reason: "tool_failed",
      result: { error: "tool_failed" },
      latencyMs: 1,
    };
    const cases: [string, Partial<AuditDeps>][] = [
      ...(["network", "timeout", "unknown", "rate_limited", "unavailable"] as const).map(
        (c): [string, Partial<AuditDeps>] => [c, { complete: fakeModel(() => Promise.reject(new AiError(c))) }],
      ),
      ["incomplete", { complete: fakeModel(() => okResult("", "incomplete")) }],
      ["gateway failed", { callTool: fakeTool(failed).fn }],
      ["gateway threw", { callTool: () => Promise.reject(new Error("db down")) }],
    ];
    for (const [name, over] of cases) {
      const { store, log } = fakeStore({}, false, 2);
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, ...over }));
      expect(out, name).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
      expect(log.writes, name).toEqual([{ verdict: "unknown", agrees: null, callId: null, concerns: ["insufficient_evidence"] }]);
      expect(log.releases, name).toBe(0);
    }
    // A real answer on the third attempt is stored as it is.
    const { store, log } = fakeStore({}, false, 2);
    expect(await runAudit(SESSION, PROPOSAL, deps({ store }))).toMatchObject({ state: "done", verdict: "pass" });
    expect(log.writes[0]).toMatchObject({ verdict: "pass", agrees: true });
  });

  it("stores unknown with no evidence read and no call past the third attempt (a lapsed lease)", async () => {
    const { store, log } = fakeStore({}, false, 3);
    const model = fakeModel(() => okResult(verdictText()));
    const tool = fakeTool();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: tool.fn }));
    expect(out).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
    expect(log.writes).toEqual([{ verdict: "unknown", agrees: null, callId: null, concerns: ["insufficient_evidence"] }]);
    expect(model).not.toHaveBeenCalled();
    expect(tool.calls).toHaveLength(0);
  });

  it("writes unknown on any other refusal (auth, not configured, a bad request)", async () => {
    for (const category of ["auth", "not_configured", "disabled", "bad_request", "too_long"] as const) {
      const { store, log } = fakeStore();
      await runAudit(SESSION, PROPOSAL, deps({ store, complete: fakeModel(() => Promise.reject(new AiError(category))) }));
      expect(log.writes[0], category).toMatchObject({ verdict: "unknown", concerns: ["insufficient_evidence"] });
    }
  });

  it("makes no model call when a verdict is already stored", async () => {
    const { store, log } = fakeStore({ verdict: "block", concerns: ["amount_wrong"], checkedAt: "2026-10-28T14:30:00.000Z" });
    const model = fakeModel(() => okResult(verdictText()));
    const tool = fakeTool();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: tool.fn }));
    expect(out).toEqual({ state: "done", verdict: "block", concerns: ["amount_wrong"], checkedAt: "2026-10-28T14:30:00.000Z" });
    expect(model).not.toHaveBeenCalled();
    expect(tool.calls).toHaveLength(0);
    expect(log.leases).toBe(0);
  });

  it("refuses a second caller while the lease is held, and lets one in after 90 seconds", async () => {
    const { store } = fakeStore({ startedAt: new Date(NOW.getTime() - 30_000).toISOString() });
    const model = fakeModel(() => okResult(verdictText()));
    expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }))).toEqual({ state: "in_progress" });
    expect(model).not.toHaveBeenCalled();
    const later = new Date(NOW.getTime() + 60_001);
    expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, clock: () => later }))).toMatchObject({
      state: "done",
      verdict: "pass",
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("makes one call for two page loads at once", async () => {
    const { store } = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = fakeModel(async () => {
      await gate;
      return okResult(verdictText());
    });
    const first = runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const second = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(second).toEqual({ state: "in_progress" });
    release();
    expect(await first).toMatchObject({ state: "done", verdict: "pass" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("stores nothing from a run whose lease lapsed and was taken over, and reports in progress, not its answer", async () => {
    const { store, log, state } = fakeStore();
    const later = new Date(NOW.getTime() + 90_000);
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    const modelB = fakeModel(async () => {
      await gateB;
      return okResult(verdictText({ verdict: "block", concerns: ["amount_wrong"] }));
    });
    let runB: Promise<AuditResult> | undefined;
    // A's call outlives its 90-second lease: B takes the lease and is still checking when A answers.
    const modelA = fakeModel(async () => {
      runB = runAudit(SESSION, PROPOSAL, deps({ store, complete: modelB, clock: () => later }));
      await vi.waitFor(() => expect(modelB).toHaveBeenCalledTimes(1));
      return okResult(verdictText());
    });
    expect(await runAudit(SESSION, PROPOSAL, deps({ store, complete: modelA }))).toEqual({ state: "in_progress" });
    expect(modelA).toHaveBeenCalledTimes(1);
    expect(log.writes).toEqual([]);
    expect(log.releases).toBe(0);
    expect(state).toMatchObject({ verdict: null, startedAt: later.toISOString() });

    // B answers under its own lease, and its verdict is the one stored.
    releaseB();
    expect(await runB).toMatchObject({ state: "done", verdict: "block", concerns: ["amount_wrong"] });
    expect(log.writes).toEqual([
      { verdict: "block", agrees: false, callId: "c0ffee00-0000-4000-8000-000000000001", concerns: ["amount_wrong"] },
    ]);
    expect(log.leases).toBe(2);
    expect(modelB).toHaveBeenCalledTimes(1);
  });

  it("reads back the stored verdict when someone else wrote first", async () => {
    const { store, state } = fakeStore();
    const model = fakeModel(async () => {
      state.verdict = "concerns";
      state.concerns = ["source_missing"];
      state.checkedAt = "2026-10-28T14:59:59.000Z";
      return okResult(verdictText());
    });
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(out).toEqual({ state: "done", verdict: "concerns", concerns: ["source_missing"], checkedAt: "2026-10-28T14:59:59.000Z" });
  });

  it("does not audit a decided proposal, one from before the start date, or one it cannot find", async () => {
    const model = fakeModel(() => okResult(verdictText()));
    const decided = fakeStore({ status: "approved" });
    expect(await runAudit(SESSION, PROPOSAL, deps({ store: decided.store, complete: model }))).toEqual({ state: "not_auditable" });
    const old = fakeStore({ createdAt: "2026-10-26T23:59:59.999Z" });
    expect(await runAudit(SESSION, PROPOSAL, deps({ store: old.store, complete: model }))).toEqual({ state: "not_auditable" });
    const missing = fakeStore({}, true);
    expect(await runAudit(SESSION, PROPOSAL, deps({ store: missing.store, complete: model }))).toEqual({ state: "not_found" });
    expect(model).not.toHaveBeenCalled();
    expect(decided.log.leases + old.log.leases + missing.log.leases).toBe(0);
  });

  it("writes unknown with no model call when the gateway refuses the read", async () => {
    for (const [decision, reason] of [
      ["blocked", "unknown_record"],
      ["denied", "role_not_allowed"],
      ["invalid_args", "invalid_args"],
      ["unknown_tool", "unknown_tool"],
    ] as const) {
      const { store, log } = fakeStore();
      const model = fakeModel(() => okResult(verdictText()));
      const refused: GatewayOutcome = { decision, decisionId: "d-2", tool: "get_proposal", reason, result: {}, latencyMs: 1 };
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: fakeTool(refused).fn }));
      expect(out, decision).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
      expect(log.writes, decision).toHaveLength(1);
      expect(log.writes[0].callId, decision).toBeNull();
      expect(log.releases, decision).toBe(0);
      expect(model, decision).not.toHaveBeenCalled();
    }
  });

  it("gives the lease back with no model call when the gateway read fails, and stores nothing", async () => {
    // A tool failure or the evidence deadline, and one whose decision could not be recorded.
    for (const decisionId of ["d-3", ""]) {
      const { store, log, state } = fakeStore();
      const model = fakeModel(() => okResult(verdictText()));
      const failed: GatewayOutcome = {
        decision: "failed",
        decisionId,
        tool: "get_proposal",
        reason: "tool_failed",
        result: { error: "tool_failed" },
        latencyMs: 1,
      };
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: fakeTool(failed).fn }));
      expect(out, decisionId).toEqual({ state: "in_progress" });
      expect(log.writes, decisionId).toEqual([]);
      expect(log.releases, decisionId).toBe(1);
      expect(state, decisionId).toMatchObject({ verdict: null, startedAt: null });
      expect(model, decisionId).not.toHaveBeenCalled();
    }
  });

  it("reports no verdict when the proposal was decided during the call and took none", async () => {
    const { store, log, state } = fakeStore();
    const model = fakeModel(async () => {
      state.status = "rejected";
      return okResult(verdictText());
    });
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(out).toEqual({ state: "not_auditable" });
    expect(log.writes).toEqual([]);
    expect(state.verdict).toBeNull();
  });

  it("gives the lease back and stores nothing when the gateway itself throws", async () => {
    const { store, log } = fakeStore();
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, callTool: () => Promise.reject(new Error("db down")) }));
    expect(out).toEqual({ state: "in_progress" });
    expect(log.writes).toEqual([]);
    expect(log.releases).toBe(1);
  });

  it("refuses any Wonder id but muse-wonder-1.0 with no call", async () => {
    for (const id of ["muse-wonder-1.0-contributor", "muse-spark-1.3", ""]) {
      const { store, log } = fakeStore();
      const model = fakeModel(() => okResult(verdictText()));
      const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, env: { META_MODEL_WONDER: id } }));
      expect(out, id).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
      expect(log.writes, id).toHaveLength(1);
      expect(model, id).not.toHaveBeenCalled();
    }
  });

  it("sends the model no outside text: no body, text, textLines or bytes key at any depth", async () => {
    const { store } = fakeStore();
    const model = fakeModel(() => okResult(verdictText()));
    await runAudit(SESSION, PROPOSAL, deps({ store, complete: model }));
    const sent = JSON.parse(model.mock.calls[0][1].messages[1].content as string) as unknown;
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(sent);
    for (const key of ["body_text", "text", "textLines", "bytes", "auditor_override_reason"]) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(model.mock.calls[0][1].messages[0]).toMatchObject({ role: "system" });
  });
});

// The code-side engine check (design 3.6): stored on the audit's own trace before the evidence
// read and the model call, so it lands whatever the call does, and never changes the verdict.
describe("runAudit and the engine check", () => {
  it("stores the engine check before the model call, on the audit's trace", async () => {
    const { store, log } = fakeStore();
    const tool = fakeTool();
    const model = fakeModel(() => {
      expect(log.engineChecks).toHaveLength(1);
      return okResult(verdictText());
    });
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, callTool: tool.fn, complete: model }));
    expect(out).toMatchObject({ state: "done", verdict: "pass" });
    expect(log.order).toEqual(["engine", "verdict"]);
    expect(log.engineChecks).toEqual([tool.calls[0].ctx.traceId]);
  });

  it("stores the engine check when the call fails, the evidence read fails, or the call is refused", async () => {
    const failed: GatewayOutcome = {
      decision: "failed",
      decisionId: "d-3",
      tool: "get_proposal",
      reason: "tool_failed",
      result: { error: "tool_failed" },
      latencyMs: 1,
    };
    const cases: [string, Partial<AuditDeps>][] = [
      ["timeout", { complete: fakeModel(() => Promise.reject(new AiError("timeout"))) }],
      ["cap", { complete: fakeModel(() => Promise.reject(new AiError("cap"))) }],
      ["evidence", { callTool: fakeTool(failed).fn }],
    ];
    for (const [name, over] of cases) {
      const { store, log } = fakeStore();
      await runAudit(SESSION, PROPOSAL, deps({ store, ...over }));
      expect(log.engineChecks, name).toHaveLength(1);
    }
  });

  it("keeps the verdict as it was when storing the engine check throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, log } = fakeStore();
    store.checkEngine = async () => {
      throw Object.assign(new Error("connection reset for tenant 7"), { name: "DbError" });
    };
    const out = await runAudit(SESSION, PROPOSAL, deps({ store }));
    expect(out).toMatchObject({ state: "done", verdict: "pass" });
    expect(log.writes).toHaveLength(1);
    // The error's name only, never its message.
    expect(warn.mock.calls.flat().join(" ")).toContain("DbError");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tenant 7");
  });

  it("runs no engine check with no lease: off, a stored verdict, or another caller checking", async () => {
    flags.auditorEnabled = false;
    const off = fakeStore();
    await runAudit(SESSION, PROPOSAL, deps({ store: off.store }));
    expect(off.log.engineChecks).toEqual([]);
    flags.auditorEnabled = true;
    const stored = fakeStore({ verdict: "pass", checkedAt: NOW.toISOString() });
    await runAudit(SESSION, PROPOSAL, deps({ store: stored.store }));
    expect(stored.log.engineChecks).toEqual([]);
    const held = fakeStore({ startedAt: NOW.toISOString() });
    expect(await runAudit(SESSION, PROPOSAL, deps({ store: held.store }))).toEqual({ state: "in_progress" });
    expect(held.log.engineChecks).toEqual([]);
  });
});

describe("runEngineCheck", () => {
  it("checks a waiting proposal alone, with no lease and no model call, whatever the switch", async () => {
    flags.auditorEnabled = false;
    const { store, log } = fakeStore();
    const model = fakeModel(() => okResult(verdictText()));
    await runEngineCheck(SESSION, PROPOSAL, deps({ store, complete: model }));
    expect(log.engineChecks).toHaveLength(1);
    expect(log.leases).toBe(0);
    expect(model).not.toHaveBeenCalled();
  });

  it("leaves a decided or missing proposal alone and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decided = fakeStore({ status: "approved" });
    await runEngineCheck(SESSION, PROPOSAL, deps({ store: decided.store }));
    expect(decided.log.engineChecks).toEqual([]);
    const missing = fakeStore({}, true);
    await runEngineCheck(SESSION, PROPOSAL, deps({ store: missing.store }));
    expect(missing.log.engineChecks).toEqual([]);
    const broken = fakeStore();
    broken.store.read = async () => {
      throw Object.assign(new Error("boom"), { name: "DbError" });
    };
    await expect(runEngineCheck(SESSION, PROPOSAL, deps({ store: broken.store }))).resolves.toBeUndefined();
    expect(broken.log.engineChecks).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

// The office's kept notes in the evidence (CARRIER-MEMORY PR 2): the prompt says what they are only
// when they are there, and the verdict names the notes the call saw, in the same write.
describe("runAudit with carrier notes", () => {
  const NOTE_A = "7d6c5b4a-3928-4170-8e6f-000000000001";
  const NOTE_B = "7d6c5b4a-3928-4170-8e6f-000000000002";
  const WITH_NOTES = {
    ...PACK,
    notes: [
      { id: NOTE_A, text: "Prefers a text before a call" },
      { id: NOTE_B, text: "Fuel advances only on Fridays" },
      { id: NOTE_A, text: "Prefers a text before a call" },
      { id: "not-a-uuid", text: "x" },
    ],
  };

  it("adds the notes rule to the prompt and names the notes the call saw with the verdict", async () => {
    const { store, log } = fakeStore();
    const model = fakeModel(() => okResult(verdictText()));
    await runAudit(SESSION, PROPOSAL, deps({ store, callTool: fakeTool(allowed(WITH_NOTES)).fn, complete: model }));
    const system = model.mock.calls[0][1].messages[0].content as string;
    expect(system).toBe(`${AUDITOR_PROMPT}\n${AUDITOR_NOTES_RULE}`);
    expect(log.writes).toEqual([
      {
        verdict: "pass",
        agrees: true,
        callId: "c0ffee00-0000-4000-8000-000000000001",
        concerns: [],
        notesUsed: [NOTE_A, NOTE_B],
      },
    ]);
  });

  it("keeps the prompt and the write unchanged when the evidence has no notes", async () => {
    for (const pack of [PACK, { ...PACK, notes: [] }, { ...PACK, notes: "Prefers a text" }]) {
      const { store, log } = fakeStore();
      const model = fakeModel(() => okResult(verdictText()));
      await runAudit(SESSION, PROPOSAL, deps({ store, callTool: fakeTool(allowed(pack)).fn, complete: model }));
      expect(model.mock.calls[0][1].messages[0].content).toBe(AUDITOR_PROMPT);
      expect(log.writes[0]).not.toHaveProperty("notesUsed");
    }
  });

  it("names no notes when no call answered, as on a budget refusal", async () => {
    const { store, log } = fakeStore();
    const model = fakeModel(() => Promise.reject(new AiError("cap")));
    await runAudit(SESSION, PROPOSAL, deps({ store, callTool: fakeTool(allowed(WITH_NOTES)).fn, complete: model }));
    expect(log.writes).toEqual([{ verdict: "unknown", agrees: null, callId: null, concerns: ["budget"] }]);
  });

  it("names at most four notes", async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `7d6c5b4a-3928-4170-8e6f-00000000001${i}`);
    const { store, log } = fakeStore();
    const pack = { ...PACK, notes: ids.map((id) => ({ id, text: "n" })) };
    await runAudit(SESSION, PROPOSAL, deps({ store, callTool: fakeTool(allowed(pack)).fn }));
    expect(log.writes[0].notesUsed).toEqual(ids.slice(0, 4));
  });
});
