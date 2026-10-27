import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import type { AuditState, AuditStore, VerdictWrite } from "../gateway/store";
import type { CompleteFn, GatewayContext, GatewayOutcome, ToolCall } from "../gateway/types";
import { AiError, runAudit, type AuditDeps } from "./run";

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

function fakeStore(over: Partial<AuditState> = {}, missing = false) {
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
  const log = { leases: 0, releases: 0, writes: [] as VerdictWrite[] };
  const store: AuditStore = {
    read: async () => (missing ? null : { ...state, concerns: [...state.concerns] }),
    lease: async (_id, now, ms, trace) => {
      if (state.verdict !== null || state.status !== "proposed") return null;
      if (state.startedAt !== null && Date.parse(state.startedAt) > now.getTime() - ms) return null;
      log.leases += 1;
      state.startedAt = now.toISOString();
      state.traceId ??= trace;
      return state.traceId;
    },
    release: async (_id, startedAt) => {
      log.releases += 1;
      if (state.startedAt === startedAt.toISOString()) state.startedAt = null;
    },
    write: async (_id, v, now) => {
      if (state.verdict !== null) return false;
      log.writes.push(v);
      state.verdict = v.verdict;
      state.concerns = [...v.concerns];
      state.checkedAt = now.toISOString();
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
      maxOutputTokens: 700,
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

  it("turns a block with no concern, bad JSON or an incomplete answer into unknown", async () => {
    for (const result of [
      okResult(verdictText({ verdict: "block" })),
      okResult("not json"),
      okResult("", "incomplete"),
    ]) {
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

  it("writes unknown on any other refusal (auth, not configured)", async () => {
    for (const category of ["auth", "not_configured", "disabled"] as const) {
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

  it("writes unknown with no model call when the gateway does not allow the read", async () => {
    const { store, log } = fakeStore();
    const model = fakeModel(() => okResult(verdictText()));
    const refused: GatewayOutcome = { decision: "blocked", decisionId: "d-2", tool: "get_proposal", reason: "unknown_record", result: {}, latencyMs: 1 };
    const out = await runAudit(SESSION, PROPOSAL, deps({ store, complete: model, callTool: fakeTool(refused).fn }));
    expect(out).toMatchObject({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"] });
    expect(log.writes[0].callId).toBeNull();
    expect(model).not.toHaveBeenCalled();
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
