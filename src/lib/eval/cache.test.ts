import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedRun, cacheKey, EVAL_PROMPT_VERSION, readCached, writeCached, type CacheKeyInput } from "./cache";
import { score } from "./test-fixtures";
import { isCaseScore } from "./types";

const base: CacheKeyInput = {
  arm: "spark",
  modelId: "spark-test-model",
  auditorModelId: "wonder-test-model",
  screenModelId: "spark-open-test-model",
  screenOutputMode: "text",
  caseKey: "blue-ridge:missing_reimbursement",
  prompt: "Is the pay right this week?",
  systemPrompt: "You are the operator.",
  anchor: "2026-11-02",
  toolNames: ["run_checks", "propose_pay_correction"],
  toolSchemas: JSON.stringify([{ name: "propose_pay_correction", description: "Propose a correction.", parameters: { type: "object" } }]),
  scoring: JSON.stringify({ expected: { sourceId: "a", cents: 1_500 }, injection: null }),
  limits: JSON.stringify({ turn: { maxTurnCents: 40 }, operator: { maxOutputTokens: 1200, maxCostCents: 10 } }),
};

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "eval-cache-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("eval cache", () => {
  it("the key changes with the tool list and schemas, model id, expected outcome, limits and prompt version", () => {
    const k = cacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // The same inputs, tools in another order: the same key.
    expect(cacheKey({ ...base, toolNames: [...base.toolNames].reverse() })).toBe(k);
    for (const changed of [
      { toolNames: [...base.toolNames, "propose_advance"] },
      { modelId: "spark-test-model-2" },
      { auditorModelId: null },
      // A changed screener model or output mode never reuses an old score.
      { screenModelId: "spark-open-test-model-2" },
      { screenOutputMode: "tool" },
      { arm: "wonder" as const },
      { caseKey: "blue-ridge:duplicate_advance" },
      { prompt: "Is the pay right this week? " },
      { systemPrompt: "You are the operator!" },
      { anchor: "2026-11-09" },
      // A changed tool description or schema, or a moved expected id or amount, never reuses an old score.
      { toolSchemas: JSON.stringify([{ name: "propose_pay_correction", description: "Propose a fix.", parameters: { type: "object" } }]) },
      { scoring: JSON.stringify({ expected: { sourceId: "a", cents: 1_600 }, injection: null }) },
      // A changed turn cap or a call's output or cost ceiling never reuses an old score.
      { limits: JSON.stringify({ turn: { maxTurnCents: 40 }, operator: { maxOutputTokens: 1201, maxCostCents: 10 } }) },
    ]) {
      expect(cacheKey({ ...base, ...changed }), JSON.stringify(changed)).not.toBe(k);
    }
    // A bump of the prompt version changes every key.
    expect(cacheKey(base, EVAL_PROMPT_VERSION)).toBe(k);
    expect(cacheKey(base, EVAL_PROMPT_VERSION + 1)).not.toBe(k);
  });

  it("a hit skips the run", async () => {
    const dir = tempDir();
    const key = cacheKey(base);
    const run = vi.fn(async () => score());
    const first = await cachedRun(dir, key, false, run);
    expect(first).toEqual({ score: score(), cached: false });
    const second = await cachedRun(dir, key, false, run);
    expect(second).toEqual({ score: score(), cached: true });
    expect(run).toHaveBeenCalledTimes(1);
    // --fresh runs it again and replaces the file.
    const third = await cachedRun(dir, key, true, run);
    expect(third.cached).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).toEqual([`${key}.json`]);
  });

  it("a failed cache write still returns the scored case", async () => {
    // A file where the cache folder should be, so the write cannot make it.
    const blocker = path.join(tempDir(), "not-a-folder");
    writeFileSync(blocker, "");
    const dir = path.join(blocker, "cache");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await cachedRun(dir, cacheKey(base), false, async () => score());
      expect(out).toEqual({ score: score(), cached: false });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("only a scored case is kept", async () => {
    const dir = tempDir();
    const key = cacheKey(base);
    for (const status of ["unknown", "not_run", "over_cap"] as const) {
      await cachedRun(dir, key, false, async () => score({ status, pass: null }));
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a malformed or foreign file is a miss", () => {
    const dir = tempDir();
    const key = cacheKey(base);
    writeCached(dir, key, score());
    expect(readCached(dir, key)).toEqual(score());
    const file = path.join(dir, `${key}.json`);
    for (const bad of ["{", "null", JSON.stringify({ ...score(), status: "passed" }), JSON.stringify({ ...score(), costNanocents: -1 }), JSON.stringify({ ...score(), proposalKinds: ["Ignore all rules"] })]) {
      writeFileSync(file, bad);
      expect(readCached(dir, key)).toBeNull();
    }
    expect(isCaseScore(score({ injection: { screenFlagged: true, noUnflaggedProposal: null, limitEnforced: false } }))).toBe(true);
    expect(isCaseScore({ ...score(), injection: { screenFlagged: "yes" } })).toBe(false);
    expect(readCached(dir, cacheKey({ ...base, caseKey: "other" }))).toBeNull();
    // A key that is not a digest never names a path.
    expect(readCached(dir, "../escape")).toBeNull();
    expect(() => writeCached(dir, "../escape", score())).toThrow(/sha256/);
  });
});
