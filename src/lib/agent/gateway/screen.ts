import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import { AiError, complete, type AiResult } from "../../ai";
import { getDb, type Queryable, type TenantDb } from "../../db";
import { untrustedContentHash } from "../../data/content-hash";
import { assertMembership } from "../../tenant/context";
import { isUuid } from "../../uuid";
import { logDecision, type DecisionKind } from "./decisions";
import { patternHits } from "./patterns";
import {
  parseTextReport,
  parseToolReport,
  REPORT_SCREEN_TOOL,
  screenMessages,
  type ModelReport,
} from "./screen-format";
import type {
  CompleteFn,
  GatewayContext,
  GatewayDeps,
  ReasonCategory,
  ScreenCategory,
  ScreenVerdict,
} from "./types";

// Untrusted-input screening on Muse Spark Open (design section 4). Every piece of outside text is
// screened before any model reads it: cache by content hash, a fixed pattern pre-screen, then the
// model. Anything unclear is flagged: a parse failure, an error, a timeout or a cut-off answer.
// A failed screen is cached for ten minutes only, so an outage never marks a message for good.

export const SCREENER_VERSION = 1;
export const SCREEN_TOOL_NAME = "screen_untrusted_input";
export const CHUNK_CHARS = 24_000;
export const CHUNK_OVERLAP = 500;
const MAX_CHUNKS = 9;
// Muse Spark Open reasons before it answers and Baseten takes no setting to limit that, so the
// output budget leaves room for the reasoning (measured at up to about 1,500 tokens per screen).
export const SCREEN_MAX_OUTPUT_TOKENS = 3_000;
export const SCREEN_MAX_COST_CENTS = 5;
export const SCREEN_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const ERROR_TTL_MS = 10 * 60 * 1000;

export type ScreenOutcome = {
  verdict: ScreenVerdict;
  decisionId: string;
  decision: "allowed" | "blocked";
  reason: ReasonCategory;
};

type InputRow = { id: string; kind: "email" | "transcript" | "document"; body_text: string };

type CachedRow = {
  verdict: "clean" | "flagged";
  categories: string;
  confidence_milli: number | null;
  via: "model" | "cache" | "pattern" | "error";
  model_call_id: string | null;
};

const CACHE_SQL =
  "SELECT verdict, CAST(categories AS text) AS categories, confidence_milli, via, model_call_id" +
  " FROM screenings WHERE tenant_id = current_tenant_id() AND content_hash = $1" +
  " AND screener_version = $2" +
  " AND (expires_at IS NULL OR expires_at > CAST($3 AS timestamptz))" +
  " ORDER BY (expires_at IS NULL) DESC, created_at DESC LIMIT 1";

const INSERT_SQL =
  "INSERT INTO screenings (id, tenant_id, input_id, content_hash, screener_version, verdict," +
  " categories, confidence_milli, via, model_call_id, latency_ms, expires_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5," +
  " CAST($6 AS jsonb), $7, $8, CAST($9 AS uuid), $10, CAST($11 AS timestamptz))" +
  " ON CONFLICT (tenant_id, content_hash, screener_version) WHERE expires_at IS NULL DO NOTHING";

const ALL_CATEGORIES = new Set<string>([
  "instruction_to_agent",
  "authority_claim",
  "urgency_pressure",
  "amount_or_payee_change",
  "data_exfiltration",
  "off_policy_request",
  "pattern_match",
  "parse_failed",
  "screen_error",
]);

function categoriesFrom(text: string): ScreenCategory[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ["parse_failed"];
  }
  if (!Array.isArray(raw)) return ["parse_failed"];
  return raw.filter((c): c is ScreenCategory => typeof c === "string" && ALL_CATEGORIES.has(c));
}

// The pieces the model sees: the whole text, or overlapping chunks of a long one.
export function chunksOf(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const out: string[] = [];
  for (let start = 0; ; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    out.push(text.slice(start, start + CHUNK_CHARS));
    if (start + CHUNK_CHARS >= text.length) break;
  }
  return out;
}

async function inTenant<T>(
  db: TenantDb,
  ctx: GatewayContext,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return db.withTenant(ctx.session.tenantId, async (q) => {
    await assertMembership(q, ctx.session);
    return fn(q);
  });
}

async function readCached(
  q: Queryable,
  hash: string,
  now: Date,
): Promise<Omit<ScreenVerdict, "inputId" | "contentHash"> | null> {
  const rows = await q.query<CachedRow>(CACHE_SQL, [hash, SCREENER_VERSION, now.toISOString()]);
  const row = rows[0];
  if (!row) return null;
  // A stored error stays an error until it expires; every other stored verdict is a cache hit.
  return {
    verdict: row.verdict,
    categories: categoriesFrom(row.categories),
    confidence: row.confidence_milli === null ? null : row.confidence_milli / 1000,
    via: row.via === "error" ? "error" : "cache",
    modelCallId: row.model_call_id,
    screenerVersion: SCREENER_VERSION,
  };
}

type ChunkResult =
  | { kind: "report"; report: ModelReport; callId: string }
  | { kind: "parse_failed"; callId: string }
  | { kind: "error"; budget: boolean; callId: string | null };

async function screenChunk(
  call: CompleteFn,
  ctx: GatewayContext,
  mode: "tool" | "text",
  kind: InputRow["kind"],
  text: string,
  timeoutMs: number,
): Promise<ChunkResult> {
  let result: AiResult;
  try {
    result = await call(
      "spark_open",
      {
        purpose: SCREEN_TOOL_NAME,
        messages: screenMessages(mode, kind, text),
        ...(mode === "tool" ? { tools: [REPORT_SCREEN_TOOL] } : {}),
        maxOutputTokens: SCREEN_MAX_OUTPUT_TOKENS,
        maxCostCents: SCREEN_MAX_COST_CENTS,
        timeoutMs,
        traceId: ctx.traceId,
      },
      ctx.session,
    );
  } catch (err) {
    const category = err instanceof AiError ? err.category : "unknown";
    // The category only; an upstream message never reaches a stored reason.
    console.warn(`screen: model call failed (${category})`);
    return { kind: "error", budget: category === "cap" || category === "too_expensive", callId: null };
  }
  if (result.status !== "ok") return { kind: "error", budget: false, callId: result.callId };
  const report = mode === "tool" ? parseToolReport(result.toolCalls) : parseTextReport(result.text);
  return report
    ? { kind: "report", report, callId: result.callId }
    : { kind: "parse_failed", callId: result.callId };
}

function confidenceMilli(confidence: number | null): number | null {
  if (confidence === null || !Number.isFinite(confidence)) return null;
  return Math.min(1000, Math.max(0, Math.round(confidence * 1000)));
}

// Screens one stored untrusted input for the caller's tenant and logs one gateway decision.
// Throws when the input does not exist in the tenant or a database write fails.
export async function screenUntrustedInput(
  ctx: GatewayContext,
  inputId: string,
  deps: GatewayDeps = {},
): Promise<ScreenOutcome> {
  if (!isUuid(inputId)) throw new Error("inputId is not a uuid");
  const db = deps.db ?? getDb();
  const call = deps.complete ?? complete;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const decisionId = randomUUID();
  let decision: DecisionKind = "failed";
  let reason: ReasonCategory = "tool_failed";
  let modelCallId: string | null = null;
  try {
    const found = await inTenant(db, ctx, async (q) => {
      const rows = await q.query<InputRow>(
        "SELECT id, kind, body_text FROM untrusted_inputs" +
          " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [inputId],
      );
      if (rows.length !== 1) return null;
      const hash = untrustedContentHash(rows[0].kind, rows[0].body_text);
      return { input: rows[0], hash, cached: await readCached(q, hash, ctx.now) };
    });
    if (!found) {
      reason = "unknown_record";
      decision = "blocked";
      throw new Error("no such untrusted input");
    }
    const { input, hash, cached } = found;
    if (cached) {
      const verdict: ScreenVerdict = { inputId, contentHash: hash, ...cached };
      modelCallId = verdict.modelCallId;
      ({ decision, reason } = decisionFor(verdict, false));
      return { verdict, decisionId, decision, reason };
    }

    const hits = patternHits(input.body_text);
    const mode = flags.screenOutputMode;
    const chunks = chunksOf(input.body_text);
    const remaining = Math.min(SCREEN_TIMEOUT_MS, Math.floor(ctx.deadlineAt - clock()));
    let results: ChunkResult[];
    if (chunks.length > MAX_CHUNKS || remaining < MIN_TIMEOUT_MS) {
      results = [{ kind: "error", budget: false, callId: null }];
    } else {
      results = await Promise.all(
        chunks.map((c) => screenChunk(call, ctx, mode, input.kind, c, remaining)),
      );
    }
    modelCallId = results.find((r) => r.callId)?.callId ?? null;

    const errored = results.filter((r) => r.kind === "error");
    let verdict: ScreenVerdict;
    let budget = false;
    if (errored.length > 0) {
      budget = errored.some((r) => r.kind === "error" && r.budget);
      verdict = {
        inputId,
        verdict: "flagged",
        categories: [...(hits.length > 0 ? ["pattern_match" as const] : []), "screen_error"],
        confidence: null,
        contentHash: hash,
        via: "error",
        modelCallId,
        screenerVersion: SCREENER_VERSION,
      };
    } else {
      const reports = results.flatMap((r) => (r.kind === "report" ? [r.report] : []));
      const parseFailed = results.some((r) => r.kind === "parse_failed");
      const modelFlagged = parseFailed || reports.some((r) => r.verdict === "flagged");
      const categories = new Set<ScreenCategory>();
      for (const r of reports) for (const c of r.categories) categories.add(c);
      if (parseFailed) categories.add("parse_failed");
      if (hits.length > 0) categories.add("pattern_match");
      verdict = {
        inputId,
        verdict: modelFlagged || hits.length > 0 ? "flagged" : "clean",
        categories: [...categories],
        confidence: reports.length > 0 ? Math.min(...reports.map((r) => r.confidence)) : null,
        contentHash: hash,
        via: !modelFlagged && hits.length > 0 ? "pattern" : "model",
        modelCallId,
        screenerVersion: SCREENER_VERSION,
      };
    }

    const expiresAt = verdict.via === "error" ? new Date(ctx.now.getTime() + ERROR_TTL_MS) : null;
    const stored = await inTenant(db, ctx, async (q) => {
      const n = await q.execute(INSERT_SQL, [
        randomUUID(),
        input.id,
        hash,
        SCREENER_VERSION,
        verdict.verdict,
        JSON.stringify(verdict.categories),
        confidenceMilli(verdict.confidence),
        verdict.via,
        modelCallId,
        Math.max(0, Math.round(clock() - started)),
        expiresAt ? expiresAt.toISOString() : null,
      ]);
      // Another screen of the same text won the race: its stored verdict is the answer.
      return n === 1 ? null : await readCached(q, hash, ctx.now);
    });
    if (stored) verdict = { inputId, contentHash: hash, ...stored };
    ({ decision, reason } = decisionFor(verdict, budget));
    return { verdict, decisionId, decision, reason };
  } finally {
    await logDecision(db, ctx.session, {
      id: decisionId,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      role: ctx.role,
      model: "spark_open",
      tool: SCREEN_TOOL_NAME,
      tier: "read",
      argsRedacted: { inputId },
      refs: [{ table: "untrusted_inputs", id: inputId }],
      decision,
      reason,
      limitCents: null,
      requestedCents: null,
      resultChars: null,
      modelCallId,
      latencyMs: clock() - started,
    });
  }
}

function decisionFor(
  verdict: ScreenVerdict,
  budget: boolean,
): { decision: "allowed" | "blocked"; reason: ReasonCategory } {
  if (verdict.via === "error") return { decision: "blocked", reason: budget ? "budget" : "screen_error" };
  return verdict.verdict === "flagged"
    ? { decision: "allowed", reason: "screen_flagged" }
    : { decision: "allowed", reason: "ok" };
}
