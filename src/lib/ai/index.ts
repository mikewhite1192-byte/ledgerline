import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, getDb, type TenantDb } from "../db";
import { isUuid } from "../uuid";
import { apiKey, type SecretsClient } from "./keys";
import {
  actualCost,
  capNanocents,
  centsToDisplay,
  CREDIT_CENTS,
  estimateReserve,
  NANOCENTS_PER_CENT,
  priceFor,
} from "./prices";
import { basetenBody, BASETEN_CHAT_URL, parseBaseten } from "./providers/baseten";
import { post, type FetchFn } from "./providers/http";
import { META_RESPONSES_URL, metaBody, parseMeta } from "./providers/meta";
import { reserve, settle, type Settlement } from "./spend";
import {
  AiError,
  type AiProvider,
  type AiReasoningEffort,
  type AiRequest,
  type AiResult,
  type CallOutcome,
} from "./types";

export { AiError } from "./types";
export type {
  AiErrorCategory,
  AiFailureCategory,
  AiMessage,
  AiProvider,
  AiReasoningEffort,
  AiReplayItem,
  AiRequest,
  AiResult,
  AiTool,
  AiToolCall,
  AiUsage,
} from "./types";

// The one door to a model. Every runtime model call in the app goes through complete(): it checks
// the switch, reserves the call's worst-case cost in the spend ledger, calls the provider once,
// settles the ledger to the real cost, and writes one log line. It never retries.
//
// Call it outside withRequestTenant: it opens its own two short transactions, and a model call of
// up to 25 seconds must not sit inside one.

// Tests inject fetch and a database; under NODE_ENV=test a missing fetch is refused, so no test
// can reach the network.
export type AiDeps = { fetch?: FetchFn; db?: TenantDb; secrets?: SecretsClient };

type Options = {
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  maxCostCents: number;
  timeoutMs: number;
};

const MODEL_ENV: Record<AiProvider, string> = {
  meta: "META_MODEL_ID",
  baseten: "BASETEN_MODEL_ID",
};

const PROVIDERS: Record<
  AiProvider,
  {
    url: string;
    body: (model: string, request: AiRequest, options: Options) => unknown;
    parse: (json: unknown, httpStatus: number) => CallOutcome;
  }
> = {
  meta: { url: META_RESPONSES_URL, body: metaBody, parse: parseMeta },
  baseten: { url: BASETEN_CHAT_URL, body: basetenBody, parse: parseBaseten },
};

const PURPOSE = /^[a-z][a-z0-9_]{2,39}$/;
// Meta's rule (letters, digits, _ . -, at most one dot), and at most 64 characters.
const TOOL_NAME = /^(?=.{1,64}$)[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)?$/;
const CALL_ID = /^.{1,64}$/s;
const EFFORTS: readonly AiReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function inRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

// A malformed request is the caller's mistake: refused before any reservation.
function validate(provider: AiProvider, request: AiRequest): Options {
  const options: Options = {
    maxOutputTokens: request.maxOutputTokens ?? 1024,
    reasoningEffort: request.reasoningEffort ?? "low",
    maxCostCents: request.maxCostCents ?? 25,
    timeoutMs: request.timeoutMs ?? 25_000,
  };
  const { messages, tools = [], replay = [] } = request;
  const ok =
    PURPOSE.test(request.purpose) &&
    inRange(options.maxOutputTokens, 16, 8192) &&
    EFFORTS.includes(options.reasoningEffort) &&
    inRange(options.maxCostCents, 1, CREDIT_CENTS) &&
    inRange(options.timeoutMs, 1, 60_000) &&
    Array.isArray(messages) &&
    messages.some((m) => m.role !== "system") &&
    messages.every(
      (m) =>
        typeof m.content === "string" &&
        (m.role === "system" ||
          m.role === "user" ||
          (m.role === "assistant" &&
            (m.toolCalls ?? []).every(
              (c) =>
                CALL_ID.test(c.id) && TOOL_NAME.test(c.name) && typeof c.argumentsJson === "string",
            )) ||
          (m.role === "tool" && CALL_ID.test(m.toolCallId))),
    ) &&
    tools.every(
      (t) =>
        TOOL_NAME.test(t.name) &&
        typeof t.description === "string" &&
        typeof t.parameters === "object" &&
        t.parameters !== null &&
        !Array.isArray(t.parameters),
    ) &&
    replay.every((item) => item?.type === "reasoning") &&
    // Replayed reasoning belongs to an assistant turn, and only Meta returns it.
    (replay.length === 0 || (provider === "meta" && messages.some((m) => m.role === "assistant")));
  if (!ok) throw new AiError("bad_request");
  return options;
}

export async function complete(
  provider: AiProvider,
  request: AiRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<AiResult> {
  // The switch is read on every call, here, not by the caller.
  if (!flags.aiEnabled) throw new AiError("disabled");
  const fetchFn = deps.fetch ?? (process.env.NODE_ENV === "test" ? undefined : fetch);
  const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
  const model = process.env[MODEL_ENV[provider]] ?? "";
  const price = priceFor(provider, model);
  if (!fetchFn || cap === null || !price || !isUuid(session.tenantId)) {
    console.error(`ai: ${provider} not configured (cap, model id or test fetch)`);
    throw new AiError("not_configured");
  }
  const options = validate(provider, request);
  const key = await apiKey(provider, deps.secrets);
  if (!key) throw new AiError("not_configured");

  const target = PROVIDERS[provider];
  const body = JSON.stringify(target.body(model, request, options));
  const reserveNanocents = estimateReserve(
    price,
    new TextEncoder().encode(body).length,
    options.maxOutputTokens,
  );
  if (reserveNanocents > options.maxCostCents * NANOCENTS_PER_CENT) {
    throw new AiError("too_expensive");
  }

  const db = deps.db ?? getDb();
  const callId = randomUUID();
  const where = `ai: ${provider} ${model} ${request.purpose}`;
  await reserve(db, session, {
    callId,
    provider,
    model,
    purpose: request.purpose,
    reserveNanocents,
    capNanocents: cap,
  });

  const started = performance.now();
  const outcome = await post(
    fetchFn,
    { url: target.url, key, body, timeoutMs: options.timeoutMs },
    target.parse,
  );
  const durationMs = Math.round(performance.now() - started);

  const costNanocents = outcome.kind === "answered" ? actualCost(price, outcome.usage) : 0;
  const settlement: Settlement =
    outcome.kind === "answered"
      ? {
          kind: "answered",
          status: outcome.status,
          usage: outcome.usage,
          costNanocents,
          upstreamId: outcome.upstreamId,
          httpStatus: outcome.httpStatus,
          durationMs,
        }
      : { ...outcome, durationMs };
  // If settling fails, the row stays 'reserved' and its reservation counted, and the caller gets
  // no answer whose cost the ledger does not show.
  let notSettled: string | null = "row not reserved";
  try {
    if (await settle(db, session, callId, settlement)) notSettled = null;
  } catch (err) {
    notSettled = err instanceof DbError ? err.category : "error";
  }
  if (notSettled) {
    console.error(`${where} not settled (${notSettled}); reservation kept call=${callId}`);
    throw new AiError("unknown");
  }

  if (outcome.kind !== "answered") {
    const kept = outcome.kind === "unknown" ? " reservation kept" : "";
    console.error(
      `${where} ${outcome.kind === "refused" ? "failed" : "unknown"} ${outcome.category}` +
        ` http=${outcome.httpStatus ?? "none"} ms=${durationMs}${kept} call=${callId}`,
    );
    throw new AiError(outcome.category, outcome.httpStatus ?? undefined);
  }
  const u = outcome.usage;
  console.log(
    `${where} ${outcome.status} in=${u.input} cached=${u.cached} out=${u.output}` +
      ` reasoning=${u.reasoning} cost=${centsToDisplay(costNanocents)}c ms=${durationMs}` +
      ` id=${outcome.upstreamId ?? "none"} call=${callId}`,
  );
  return {
    callId,
    status: outcome.status,
    text: outcome.text,
    toolCalls: outcome.toolCalls,
    usage: u,
    costNanocents,
    upstreamId: outcome.upstreamId,
    replay: outcome.replay,
  };
}
