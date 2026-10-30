import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SCREENER_VERSION } from "../agent/gateway/screen";
import { isCaseScore, type Arm, type CaseScore } from "./types";

// The case cache (design 4.5): a case whose inputs did not change is not run again, so a rerun
// with nothing changed spends nothing. The key is a hash of everything that can change the
// answer; the file holds the CaseScore only (booleans, cents, milliseconds, fixed words), never
// a message or model text.

// Bump when the cases' sentences or the scorer's rules change in a way the key cannot see.
export const EVAL_PROMPT_VERSION = 2;

export const DEFAULT_CACHE_DIR = path.join("eval", "cache");

export type CacheKeyInput = {
  arm: Arm;
  // The env's model id for the target the arm sends the operator's calls to, and the second
  // check's. Null when unset (such a run is refused before any case starts).
  modelId: string | null;
  auditorModelId: string | null;
  caseKey: string;
  // The case's sentence and the operator's system prompt, hashed here and never stored.
  prompt: string;
  systemPrompt: string;
  anchor: string;
  // The operator's tool names as offered for this run.
  toolNames: readonly string[];
  // The same tools whole (name, description, parameters), as one text (run.ts armPromptOf),
  // hashed here: a changed description or schema never reuses an old score.
  toolSchemas: string;
  // The case's expected outcome and its injection check, as one text (run.ts caseScoringOf),
  // hashed here: a seed or engine change that moves an id or an amount never reuses a score
  // taken against the old one.
  scoring: string;
  // The turn's caps and each model call's output and cost ceilings, as one text (run.ts
  // armLimitsOf), hashed here: a changed limit never reuses an old score.
  limits: string;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// promptVersion is a parameter only so a test can show a bump changes every key.
export function cacheKey(i: CacheKeyInput, promptVersion: number = EVAL_PROMPT_VERSION): string {
  const parts = {
    arm: i.arm,
    modelId: i.modelId,
    auditorModelId: i.auditorModelId,
    caseKey: i.caseKey,
    promptVersion,
    prompt: sha256(i.prompt),
    systemPrompt: sha256(i.systemPrompt),
    anchor: i.anchor,
    screenerVersion: SCREENER_VERSION,
    tools: [...i.toolNames].sort(),
    toolSchemas: sha256(i.toolSchemas),
    scoring: sha256(i.scoring),
    limits: sha256(i.limits),
  };
  return sha256(JSON.stringify(parts));
}

const fileOf = (dir: string, key: string) => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("a cache key is a sha256 hex digest");
  return path.join(dir, `${key}.json`);
};

export function readCached(dir: string, key: string): CaseScore | null {
  let raw: string;
  try {
    raw = readFileSync(fileOf(dir, key), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCaseScore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Written whole, through a temporary file renamed into place, so a run cut short never leaves
// half a file.
export function writeCached(dir: string, key: string, score: CaseScore): void {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, key);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(score, null, 2)}\n`);
  renameSync(tmp, file);
}

// A hit skips the run. Only a scored case is kept: an unknown or cut case runs again next time.
// fresh ignores what is there (and replaces it).
export async function cachedRun(
  dir: string,
  key: string,
  fresh: boolean,
  run: () => Promise<CaseScore>,
): Promise<{ score: CaseScore; cached: boolean }> {
  if (!fresh) {
    const hit = readCached(dir, key);
    if (hit) return { score: hit, cached: true };
  }
  const score = await run();
  if (score.status === "scored") writeCached(dir, key, score);
  return { score, cached: false };
}
