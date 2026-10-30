import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { CompleteFn } from "../agent/gateway/types";
import { ESCALATION_CALL, OPERATOR_CALL } from "../agent/policy";
import type { AiRequest } from "../ai";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { DEMO_ANCHOR } from "../seed/anchor";
import { buildCases } from "./cases";
import { armComplete, armLimitsOf, evalClock, plainRequest, runArm, type CaseDeps } from "./run";
import { score } from "./test-fixtures";
import type { CaseScore, EvalCase } from "./types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const request = (): AiRequest => ({
  purpose: "operator_turn",
  maxCostCents: OPERATOR_CALL.maxCostCents,
  messages: [
    { role: "system", content: "rules", placement: "input" },
    { role: "user", content: "Is the pay right?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_checks", argumentsJson: "{}" }], replay: [{ type: "tool_search_call", id: "s1" }] },
    { role: "tool", content: "{}", toolCallId: "c1" },
  ],
  tools: [{ name: "run_checks", description: "d", parameters: { type: "object" }, deferLoading: true }],
  toolSearch: true,
  cache: { key: "k" },
  replay: [{ type: "reasoning", id: "r1" }, { type: "tool_search_output", id: "s2" }],
});

describe("arm redirect", () => {
  it("spark is the product's own call, unchanged", () => {
    const base = vi.fn() as unknown as CompleteFn;
    expect(armComplete("spark", base)).toBe(base);
  });

  it("the redirected arms send only the operator's spark calls, in the plain shape", async () => {
    const seen: [string, AiRequest][] = [];
    const base: CompleteFn = async (target, req) => {
      seen.push([target, req]);
      throw new Error("not called for real");
    };
    const session = {} as Session;
    for (const arm of ["wonder", "spark_open"] as const) {
      seen.length = 0;
      const complete = armComplete(arm, base);
      await expect(complete("spark", request(), session)).rejects.toThrow();
      await expect(complete("wonder", request(), session)).rejects.toThrow();
      expect(seen.map(([t]) => t)).toEqual([arm, "wonder"]);
      // The second call (the escalation or the second check) is left exactly as it was.
      expect(seen[1][1]).toEqual(request());
      const plain = seen[0][1];
      expect(plain.toolSearch).toBeUndefined();
      expect(plain.cache).toBeUndefined();
      expect(plain.tools).toEqual([{ name: "run_checks", description: "d", parameters: { type: "object" } }]);
      expect(plain.messages[0]).toEqual({ role: "system", content: "rules" });
      expect(plain.messages[2]).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_checks", argumentsJson: "{}" }] });
      expect(plain.messages[3]).toEqual({ role: "tool", content: "{}", toolCallId: "c1" });
    }
  });

  it("only wonder keeps the reasoning replay, and every arm keeps the call's own cap", () => {
    const w = plainRequest("wonder", request());
    expect(w.replay).toEqual([{ type: "reasoning", id: "r1" }]);
    expect(w.maxCostCents).toBe(OPERATOR_CALL.maxCostCents);
    const o = plainRequest("spark_open", request());
    expect(o.replay).toBeUndefined();
    expect(o.maxCostCents).toBe(OPERATOR_CALL.maxCostCents);
    // A cap the turn already lowered to what it has left stays lowered.
    expect(plainRequest("wonder", { ...request(), maxCostCents: 3 }).maxCostCents).toBe(3);
    // The operator's own cap is at least Wonder's own ceiling for an operator call, so the wonder
    // arm needs no raised cap of its own.
    expect(OPERATOR_CALL.maxCostCents).toBeGreaterThanOrEqual(ESCALATION_CALL.maxCostCents);
  });
});

describe("eval limits", () => {
  it("the limits text follows the turn's caps", () => {
    const before = armLimitsOf();
    const saved = flags.agentTurnLimits;
    try {
      flags.agentTurnLimits = { ...saved, maxTurnCents: saved.maxTurnCents + 1 };
      expect(armLimitsOf()).not.toBe(before);
    } finally {
      flags.agentTurnLimits = saved;
    }
    expect(armLimitsOf()).toBe(before);
  });
});

describe("eval clock", () => {
  it("starts on the anchor day at 16:00 UTC and moves with real time", () => {
    let now = 1_000;
    const clock = evalClock(DEMO_ANCHOR, () => now);
    expect(new Date(clock()).toISOString()).toBe(`${DEMO_ANCHOR}T16:00:00.000Z`);
    now += 2_500;
    expect(new Date(clock()).toISOString()).toBe(`${DEMO_ANCHOR}T16:00:02.500Z`);
    expect(() => evalClock("not a date", () => 0)).toThrow(/anchor/);
  });
});

describe("runArm", () => {
  const all = buildCases(DEMO_ANCHOR);
  const pick = (...keys: string[]) => keys.map((k) => all.find((c) => c.key === k) as EvalCase);
  const sessions = { "blue-ridge": { tenantId: "t1" } as Session, "prairie-wind": { tenantId: "t2" } as Session };
  const deps = { db: {} as TenantDb, complete: (async () => { throw new Error("unused"); }) as CompleteFn, clock: () => 0 };
  const armRun = (cases: EvalCase[], run: (c: EvalCase, d: CaseDeps) => Promise<CaseScore>) => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eval-run-test-"));
    dirs.push(cacheDir);
    return { arm: "spark" as const, cases, sessions, deps, anchor: DEMO_ANCHOR, modelId: "m", auditorModelId: "a", screenModelId: "s", cacheDir, fresh: false, run };
  };

  it("a skipped case is not run, and the spend stop counts the rest over the cap", async () => {
    // No built case is skipped today (the fuel checks list every planted fill-up), so the test
    // marks one the way a fill-up before the checks' start date would be.
    const [parked] = pick("prairie-wind:fuel_while_parked");
    const skipped: EvalCase = { ...parked, skip: "fuel_before_start" };
    const cases = [
      skipped,
      ...pick("blue-ridge:missing_reimbursement", "blue-ridge:duplicate_advance", "prairie-wind:missing_reimbursement"),
      skipped,
    ];
    const run = vi.fn(async (c: EvalCase, d: CaseDeps) => {
      expect(d.arm).toBe("spark");
      expect(d.session).toBe(sessions[c.carrierSlug as keyof typeof sessions]);
      return c.key === "blue-ridge:duplicate_advance" ? score({ status: "over_cap", pass: null }) : score();
    });
    const out = await runArm(armRun(cases, run));
    expect(out.stoppedAtCap).toBe(true);
    expect(out.results.map((r) => [r.caseKey, r.score.status])).toEqual([
      ["prairie-wind:fuel_while_parked", "not_run"],
      ["blue-ridge:missing_reimbursement", "scored"],
      ["blue-ridge:duplicate_advance", "over_cap"],
      ["prairie-wind:missing_reimbursement", "over_cap"],
      ["prairie-wind:fuel_while_parked", "not_run"],
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a case that throws is unknown, the next still runs, and a rerun is served from the cache", async () => {
    const cases = pick("blue-ridge:missing_reimbursement", "blue-ridge:duplicate_advance");
    const run = vi.fn(async (c: EvalCase) => {
      if (c.key === "blue-ridge:missing_reimbursement") throw new Error("store down");
      return score();
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = armRun(cases, run);
    try {
      const first = await runArm(a);
      expect(first.results.map((r) => [r.score.status, r.cached])).toEqual([
        ["unknown", false],
        ["scored", false],
      ]);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("store down");
      const second = await runArm(a);
      expect(second.results.map((r) => [r.score.status, r.cached])).toEqual([
        ["unknown", false],
        ["scored", true],
      ]);
      expect(run).toHaveBeenCalledTimes(3);
      expect(readdirSync(a.cacheDir)).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("a carrier with no session is unknown, never run", async () => {
    const run = vi.fn(async () => score());
    const a = { ...armRun(pick("blue-ridge:missing_reimbursement"), run), sessions: {} };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await runArm(a)).results[0].score.status).toBe("unknown");
    } finally {
      errors.mockRestore();
    }
    expect(run).not.toHaveBeenCalled();
  });
});
