import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readMp4Header, type Mp4Header } from "../clips/mp4";
import { ForbiddenError } from "../tenant/context";
import { isUuid } from "../uuid";
import { hostFor } from "./host";
import { apiKey, forgetKey, type SecretsClient } from "./keys";
import {
  audioReserve,
  capNanocents,
  centsToDisplay,
  estimateReserve,
  mediaReserveTokens,
  meteredCost,
  COMPUTER_TOOL_RESERVE_TOKENS,
  NANOCENTS_PER_CENT,
  SCREENSHOT_RESERVE_TOKENS,
  videoFramesCost,
  WEB_SEARCH_QUERY_NANOCENTS,
  WEB_SEARCH_RESERVE_TOKENS,
  wonderCapNanocents,
  type Price,
} from "./prices";
import { basetenBody, BASETEN_CHAT_URL, parseBaseten } from "./providers/baseten";
import { FIREWORKS_CHAT_URL, parseFireworks } from "./providers/fireworks";
import { post, type FetchFn } from "./providers/http";
import { dataUrlLength, IMAGE_MIMES, looksLike, pdfPages } from "./providers/media";
import { META_RESPONSES_URL, metaBody, metaComputerBody, parseMeta } from "./providers/meta";
import { imageBody, META_IMAGES_URL, parseImage } from "./providers/meta-image";
import { parseSam, parseSamVideo, samBody, samVideoBody } from "./providers/meta-sam";
import {
  META_TRANSCRIBE_ACCEPT,
  META_TRANSCRIBE_URL,
  parseVoice,
  voiceBody,
} from "./providers/meta-voice";
import { overCap, readSpend, reserve, settle, type Settlement } from "./spend";
import { shouldFallBack, standbyFor, type FirstAttempt } from "./standby";
import { TARGETS, contributorMode, contributorRefusesAll, modelFor } from "./targets";
import { jobCapNanocents } from "./watch";
import {
  AiError,
  type AiAttachment,
  type AiCallOptions,
  type AiLanguage,
  type AiMessage,
  type AiProvider,
  type AiReasoningEffort,
  type AiReplayItem,
  type AiRequest,
  type AiResult,
  type AiTarget,
  type AiTextTarget,
  type AiTool,
  type CallOutcome,
  type ComputerPair,
  type ComputerRequest,
  type ComputerResult,
  type ComputerScreenshot,
  type ImageRequest,
  type ImageResult,
  type Metered,
  type SegmentRequest,
  type SegmentResult,
  type SegmentVideoRequest,
  type SegmentVideoResult,
  type TextAnswer,
  type TranscribeRequest,
  type TranscribeResult,
} from "./types";
import { readWav } from "./wav";

export { AiError } from "./types";
export type {
  AiAttachment,
  AiErrorCategory,
  AiFailureCategory,
  AiFormat,
  AiImageMime,
  AiLanguage,
  AiMessage,
  AiProvider,
  AiReasoningEffort,
  AiReplayItem,
  AiRequest,
  AiResult,
  AiSearchResult,
  AiTarget,
  AiTextTarget,
  AiTool,
  AiToolCall,
  AiUsage,
  AiWebAnswer,
  AiWebSearch,
  ComputerAction,
  ComputerButton,
  ComputerCall,
  ComputerPair,
  ComputerPoint,
  ComputerRequest,
  ComputerResult,
  ComputerScreenshot,
  ImageRequest,
  ImageResult,
  SafetyCheck,
  SegmentMatch,
  SegmentRequest,
  SegmentResult,
  SegmentVideoRequest,
  SegmentVideoResult,
  TranscribeRequest,
  TranscribeResult,
  TranscribeTurn,
} from "./types";

// The one door to a model. Every runtime model call in the app goes through complete(),
// transcribe(), generateImage(), segment() or segmentVideo(), and all of them through runCall(): it checks the
// switch, reserves the call's worst-case cost in the spend ledger, calls the provider once,
// settles the ledger to the real cost, and writes one log line. It never retries a host. Muse
// Spark Open alone has a standby host (./standby.ts): while flags.sparkOpenFallback names it,
// a first attempt that failed for a reason that is the primary host's own is followed by at
// most one attempt on the standby, through the same reserve, settle and log steps with its own
// ledger row, inside the time the caller had left.
//
// Each returns its result or throws an AiError. The ledger step before the call can also throw
// the tenant module's ForbiddenError (no membership) and a DbError, so every caller handles all
// three, as src/app/ai-proof-action.ts does.
//
// Call them outside withRequestTenant: each opens its own two short transactions, and a model
// call of up to 60 seconds must not sit inside one.

// Tests inject fetch and a database; under NODE_ENV=test a missing fetch is refused, so no test
// can reach the network. clock is monotonic milliseconds (default performance.now), for each
// attempt's duration and the time a standby attempt has left; tests inject a fake one. now is the
// instant a reservation is stamped with and the job spend watch measures its hour back from;
// unset (production) means the database's own clock, and tests inject a fixed instant.
export type AiDeps = {
  fetch?: FetchFn;
  db?: TenantDb;
  secrets?: SecretsClient;
  clock?: () => number;
  now?: () => Date;
};

const PURPOSE = /^[a-z][a-z0-9_]{2,39}$/;
// Meta's rule (letters, digits, _ . -, at most one dot), and at most 64 characters.
const TOOL_NAME = /^(?=.{1,64}$)[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)?$/;
const CALL_ID = /^.{1,64}$/s;
const FORMAT_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// Our own bound on a prompt cache key; the API states none.
const CACHE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
// The API's own name for its search tool: no function may take it.
const TOOL_SEARCH_NAME = "tool_search";
const REPLAY_TYPES: readonly string[] = ["reasoning", "tool_search_call", "tool_search_output"];
// A hosted tool search reads the request again inside the same answer: measured on 2026-10-27 UTC,
// an answer that searched once billed about twice the input tokens of the same request without
// a search, more than the reserve's input guess. So a request with search on reserves its input
// twice, and the reserve stays a worst case.
const SEARCH_INPUT_FACTOR = 2;
// A plain file name: no path, no quotes, no control characters.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
// A noun phrase only, so SAM's box and point prompt tokens cannot be written into it.
const SAM_PROMPT = /^(?=.{1,40}$)[A-Za-z]+( [A-Za-z]+)*$/;
const KEYWORD = /^[^\p{Cc}]{1,50}$/u;
const SIZE = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/;

const BASE_EFFORTS: readonly AiReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const TEXT_TARGETS: readonly AiTextTarget[] = ["spark", "wonder", "spark_open"];
const LANGUAGES: readonly AiLanguage[] = ["English", "Spanish"];
const IMAGE_FORMATS: readonly string[] = ["png", "jpeg", "webp"];

// Our limits, well under Meta's: a request body stays small and a reserve under the per-call cap.
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
// The evidence clip cap, the same as the table's CHECK: 933,336 base64 characters inline, well
// under the 1 MiB request body Meta accepts.
const MAX_VIDEO_BYTES = 700_000;
const MAX_VIDEOS_PER_CALL = 1;
const MAX_IMAGES_PER_CALL = 4;
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEYWORDS = 20;
// Muse Image refuses an aspect ratio past 16:1.
const MAX_ASPECT = 16;

// The highest maxCostCents one call may ask for, in cents ($150). A bound on a single call only,
// separate from the spend caps and their ceiling in prices.ts.
const MAX_CALL_COST_CENTS = 15_000;

const DEFAULT_TIMEOUT_MS = 25_000;
const SLOW_TIMEOUT_MS = 60_000;
// A standby attempt is started only with at least this much of the caller's time left.
const MIN_STANDBY_MS = 1_000;
// Two of these run in parallel inside one upload request, so each stays well inside its budget.
const SEGMENT_VIDEO_TIMEOUT_MS = 20_000;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function bad(): never {
  throw new AiError("bad_request");
}

type Common = { purpose: string; maxCostCents: number; timeoutMs: number; traceId: string | null };

// What every call takes. A malformed request is the caller's mistake: refused before any
// reservation.
function common(options: AiCallOptions, defaultTimeoutMs: number): Common {
  const c: Common = {
    purpose: options.purpose,
    // A PDF caller must pass a higher maxCostCents. A PDF read at the 50-page worst case (no
    // readable page count, or a compressed object stream) reserves 4,000 x 50 = 200,000 input
    // tokens, which at Spark's input price (125,000 nanocents a token) is 25.0 cents before any
    // text or output, so on this default it is always refused too_expensive.
    maxCostCents: options.maxCostCents ?? 25,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    traceId: options.traceId ?? null,
  };
  if (
    typeof c.purpose !== "string" ||
    !PURPOSE.test(c.purpose) ||
    !inRange(c.maxCostCents, 1, MAX_CALL_COST_CENTS) ||
    !inRange(c.timeoutMs, 1, SLOW_TIMEOUT_MS) ||
    (c.traceId !== null && !isUuid(c.traceId))
  ) {
    bad();
  }
  return c;
}

// What one call sends, what it reserves, and how its answer is read.
type Plan<T> = {
  url: string;
  accept?: string;
  body: string | FormData;
  reserveNanocents: number;
  reasoningEffort: AiReasoningEffort | null;
  parse: (json: unknown, httpStatus: number) => CallOutcome<T>;
};

type Answered<T> = Extract<CallOutcome<T>, { kind: "answered" }>;
type Failed<T> = Exclude<CallOutcome<T>, { kind: "answered" }>;

// The ledger's units column: what a call that is not billed by tokens is billed by.
function unitsOf(metered: Metered): number | null {
  if (metered.unit === "audio_seconds") return metered.seconds;
  if (metered.unit === "images" || metered.unit === "video_frames") return metered.count;
  return null;
}

function usageLine(metered: Metered): string {
  if (metered.unit !== "tokens") return `units=${unitsOf(metered)}`;
  const u = metered.usage;
  const searches = metered.searches === undefined ? "" : ` searches=${metered.searches}`;
  return `in=${u.input} cached=${u.cached} out=${u.output} reasoning=${u.reasoning}${searches}`;
}

type PlanFn<T, U extends Price["unit"]> = (
  model: string,
  price: Extract<Price, { unit: U }>,
  provider: AiProvider,
) => Plan<T>;

// What both attempts of one call share.
type CallContext<T, U extends Price["unit"]> = {
  target: AiTarget;
  session: Session;
  deps: AiDeps;
  fetchFn: FetchFn;
  clock: () => number;
  cap: number;
  wonderCap: number | null;
  jobCap: number;
  c: Common;
  trace: string;
  plan: PlanFn<T, U>;
};

// One attempt, ready to reserve and send.
type Prepared<T, U extends Price["unit"]> = {
  provider: AiProvider;
  model: string;
  price: Extract<Price, { unit: U }>;
  p: Plan<T>;
  key: string;
};

type Sent<T> =
  | { kind: "answered"; callId: string; answer: Answered<T>; costNanocents: number }
  | { kind: "failed"; callId: string; outcome: Failed<T>; error: AiError };

// A reserve over the call's own maxCostCents: refused too_expensive before anything is reserved.
function overCallCost(reserveNanocents: number, c: Common): boolean {
  return reserveNanocents > c.maxCostCents * NANOCENTS_PER_CENT;
}

// The overall cap and, for Wonder only, its own cap inside it, read on every call. Null refuses.
function capsFor(target: AiTarget): { cap: number | null; wonderCap: number | null } {
  const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
  // Unset or invalid refuses Wonder calls only.
  const wonderCap =
    target === "wonder" ? wonderCapNanocents(process.env.AI_WONDER_CAP_CENTS, cap) : null;
  return { cap, wonderCap };
}

// Builds one attempt for one host: validates the call's own input and builds its body (plan),
// reads the host's key, and checks the reserve against the call's maxCostCents and the job's
// hourly allowance. A call that alone is over the allowance would be refused job_cap again right
// after every clear, so it is refused here, before any reservation or alert. Null, with one log
// line naming the host, when the host's key is missing or unreadable: nothing was sent.
async function prepare<T, U extends Price["unit"]>(
  ctx: CallContext<T, U>,
  provider: AiProvider,
  configured: { model: string; price: Extract<Price, { unit: U }> },
  label: "" | "fallback ",
): Promise<Prepared<T, U> | null> {
  const p = ctx.plan(configured.model, configured.price, provider);
  const key = await apiKey(provider, ctx.deps.secrets);
  if (!key) {
    console.error(`ai: ${ctx.target} ${label}not configured (no ${provider} key)`);
    return null;
  }
  if (overCallCost(p.reserveNanocents, ctx.c) || p.reserveNanocents > ctx.jobCap) {
    throw new AiError("too_expensive");
  }
  return { provider, model: configured.model, price: configured.price, p, key };
}

// One attempt: reserve, one HTTP call, settle, one log line. A failure the host reported comes
// back as "failed" with the error to throw; a refusal at the reserve (cap, the job's hourly
// allowance, membership, the database) and a failed settle throw from here. reserved() runs once the reservation is written,
// before anything is sent.
async function send<T, U extends Price["unit"]>(
  ctx: CallContext<T, U>,
  prepared: Prepared<T, U>,
  timeoutMs: () => number,
  reserved: () => void = () => {},
): Promise<Sent<T>> {
  const { target, session, c, trace } = ctx;
  const { provider, model, price, p, key } = prepared;
  const { kind } = TARGETS[target];
  const db = ctx.deps.db ?? getDb();
  // The dedupe key: the row's primary key, made here, before the reservation.
  const callId = randomUUID();
  const where = `ai: ${target} ${model} ${kind} ${c.purpose}`;
  // The local replay host in local mode only; anywhere else a set override refuses here.
  const url = hostFor(p.url);
  try {
    await reserve(db, session, {
      callId,
      target,
      provider,
      model,
      kind,
      purpose: c.purpose,
      reasoningEffort: p.reasoningEffort,
      traceId: c.traceId,
      reserveNanocents: p.reserveNanocents,
      capNanocents: ctx.cap,
      wonderCapNanocents: ctx.wonderCap,
      jobCapNanocents: ctx.jobCap,
      at: ctx.deps.now ? ctx.deps.now().toISOString() : null,
    });
  } catch (err) {
    if (err instanceof AiError && err.category === "job_cap") {
      console.error(`${where} refused: the job is over its hourly allowance${trace}`);
    }
    throw err;
  }
  reserved();

  const started = ctx.clock();
  const raw = await post(
    ctx.fetchFn,
    { url, key, body: p.body, timeoutMs: timeoutMs(), accept: p.accept },
    p.parse,
  );
  const durationMs = Math.round(ctx.clock() - started);
  // The cost is the reported usage at our price table. Meta's docs state no separate price for a
  // hosted tool search; if it is billed on top of its tokens, this figure understates that call.
  const costNanocents = raw.kind === "answered" ? meteredCost(price, raw.metered) : null;
  // An answer metered some other way than the price is not a known cost.
  const outcome: CallOutcome<T> =
    raw.kind === "answered" && costNanocents === null
      ? { kind: "unknown", category: "unknown", httpStatus: raw.httpStatus }
      : raw;
  // A refused key is not kept: the next call reads the secret again. This call is not retried.
  if (outcome.kind !== "answered" && outcome.category === "auth") forgetKey(provider);

  // A timeout settles as 'unknown' like any other unknown outcome (failure 'timeout', its
  // duration, the calls counter): whether the provider ran and charged is not known, so its
  // reservation stays counted against the cap. A row left 'reserved' therefore always means a
  // call in flight or a settle that failed.
  const settlement: Settlement =
    outcome.kind === "answered"
      ? {
          kind: "answered",
          status: outcome.status,
          usage: outcome.metered.unit === "tokens" ? outcome.metered.usage : null,
          units: unitsOf(outcome.metered),
          costNanocents: costNanocents ?? 0,
          upstreamId: outcome.upstreamId,
          httpStatus: outcome.httpStatus,
          durationMs,
        }
      : { ...outcome, durationMs };
  // If settling fails, the row stays 'reserved' and its reservation counted, and the caller gets
  // no answer whose cost the ledger does not show. No standby attempt follows.
  let notSettled: string | null = "row not reserved";
  try {
    if (await settle(db, session, callId, settlement)) notSettled = null;
  } catch (err) {
    notSettled = err instanceof DbError ? err.category : "error";
  }
  if (notSettled) {
    console.error(`${where} not settled (${notSettled}); reservation kept call=${callId}${trace}`);
    throw new AiError("unknown");
  }

  if (outcome.kind !== "answered") {
    const kept = outcome.kind === "unknown" ? " reservation kept" : "";
    console.error(
      `${where} ${outcome.kind === "refused" ? "failed" : "unknown"} ${outcome.category}` +
        ` http=${outcome.httpStatus ?? "none"} ms=${durationMs}${kept} call=${callId}${trace}`,
    );
    const error = new AiError(outcome.category, outcome.httpStatus ?? undefined);
    return { kind: "failed", callId, outcome, error };
  }
  const cost = costNanocents ?? 0;
  console.log(
    `${where} ${outcome.status} ${usageLine(outcome.metered)}` +
      ` cost=${centsToDisplay(cost)}c ms=${durationMs}` +
      ` id=${outcome.upstreamId ?? "none"} call=${callId}${trace}`,
  );
  return { kind: "answered", callId, answer: outcome, costNanocents: cost };
}

// The shared path of every model call. plan() validates the call's own input and builds its
// body for a host; it runs after the configuration checks and before that host's key is read.
async function runCall<T, U extends Price["unit"]>(
  target: AiTarget,
  unit: U,
  options: AiCallOptions,
  defaultTimeoutMs: number,
  session: Session,
  deps: AiDeps,
  plan: PlanFn<T, U>,
): Promise<{ callId: string; answer: Answered<T>; costNanocents: number }> {
  // The switch is read on every call, here, not by the caller.
  if (!flags.aiEnabled) throw new AiError("disabled");
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const fetchFn = deps.fetch ?? (process.env.NODE_ENV === "test" ? undefined : fetch);
  const { cap, wonderCap } = capsFor(target);
  const jobCap = jobCapNanocents(flags.aiJobHourlyCapCents);
  if (contributorMode(process.env.META_CONTRIBUTOR_MODE) === null) {
    console.error("ai: META_CONTRIBUTOR_MODE must be unset, true or false; every call is refused");
    throw new AiError("not_configured");
  }
  const primary = TARGETS[target].provider;
  const configured = modelFor(target, unit);
  // These reasons are ours, never a host's, so no standby host is tried after them. A primary
  // with no usable model id is the host's own reason, tried on the standby while the switch is on.
  if (
    !fetchFn ||
    cap === null ||
    jobCap === null ||
    contributorRefusesAll(process.env) ||
    !isUuid(session.tenantId) ||
    (target === "wonder" && wonderCap === null) ||
    (!configured && !standbyFor(target))
  ) {
    console.error(`ai: ${target} not configured (cap, model id or test fetch)`);
    throw new AiError("not_configured");
  }
  if (!configured) console.error(`ai: ${target} not configured (no ${primary} model id)`);
  const c = common(options, defaultTimeoutMs);
  // The caller's time budget covers every attempt.
  const deadline = started + c.timeoutMs;
  const trace = c.traceId ? ` trace=${c.traceId}` : "";
  const ctx: CallContext<T, U> = {
    target,
    session,
    deps,
    fetchFn,
    clock,
    cap,
    wonderCap,
    jobCap,
    c,
    trace,
    plan,
  };

  const prepared = configured ? await prepare(ctx, primary, configured, "") : null;
  let first: FirstAttempt = { kind: "not_sent" };
  let firstError = new AiError("not_configured");
  let firstId = "none";
  if (prepared) {
    const sent = await send(ctx, prepared, () => c.timeoutMs);
    if (sent.kind === "answered") {
      return { callId: sent.callId, answer: sent.answer, costNanocents: sent.costNanocents };
    }
    first = sent.outcome;
    firstError = sent.error;
    firstId = sent.callId;
  }

  // At most one more attempt, on the standby host, and only for a failure that is the primary
  // host's own. Unless it starts, the caller gets the first attempt's error, as with no standby.
  const standby = shouldFallBack(first) ? standbyFor(target) : null;
  if (!standby) throw firstError;
  const backup = modelFor(target, unit, standby);
  if (!backup) {
    console.error(`ai: ${target} fallback not configured (no ${standby} model id)`);
    throw firstError;
  }
  const second = await prepare(ctx, standby, backup, "fallback ");
  if (!second) throw firstError;
  // A primary that was never sent has no row to name.
  const firstRef = first.kind === "not_sent" ? "primary not sent" : `call=${firstId}`;
  const left = Math.floor(deadline - clock());
  if (left < MIN_STANDBY_MS) {
    console.error(`ai: ${target} fallback skipped (${left} ms left) ${firstRef}${trace}`);
    throw firstError;
  }
  const after = first.kind === "not_sent" ? "not_configured" : first.category;
  const http = first.kind === "not_sent" ? "none" : (first.httpStatus ?? "none");
  // The fallback line is written only once the second reservation holds, so no line says the
  // standby was tried when the cap (or anything else at the reserve) refused it; that refusal
  // gets its own line, its category only.
  let reservedSecond = false;
  let sent: Sent<T>;
  try {
    // Never more than what is left of the caller's time, measured again after the reservation.
    sent = await send(
      ctx,
      second,
      () => Math.max(1, Math.floor(deadline - clock())),
      () => {
        reservedSecond = true;
        console.error(
          `ai: ${target} falling back to ${standby} after ${after} http=${http} call=${firstId}${trace}`,
        );
      },
    );
  } catch (err) {
    if (!reservedSecond) {
      console.error(`ai: ${target} fallback refused (${refusalCategory(err)}) ${firstRef}${trace}`);
    }
    throw err;
  }
  if (sent.kind === "failed") throw sent.error;
  return { callId: sent.callId, answer: sent.answer, costNanocents: sent.costNanocents };
}

// A refusal at the reserve, for a log line: its category, never the error's own text.
function refusalCategory(err: unknown): string {
  if (err instanceof AiError || err instanceof DbError) return err.category;
  return err instanceof ForbiddenError ? "membership" : "error";
}

// --- complete: Muse Spark, Muse Wonder, Muse Spark Open ---

type TextOptions = { maxOutputTokens: number; reasoningEffort: AiReasoningEffort };

// A video's header when it is an MP4 under the cap that reads as a clip and whose declared frame
// count is the header's own; null otherwise. The reserve is computed from that count, so a
// caller cannot shrink it by declaring fewer frames.
function videoHeader(video: unknown): Mp4Header | null {
  if (typeof video !== "object" || video === null) return null;
  const v = video as { mime?: unknown; bytes?: unknown; frameCount?: unknown };
  if (
    v.mime !== "video/mp4" ||
    !(v.bytes instanceof Uint8Array) ||
    v.bytes.length === 0 ||
    v.bytes.length > MAX_VIDEO_BYTES ||
    !looksLike("video/mp4", v.bytes)
  ) {
    return null;
  }
  const read = readMp4Header(v.bytes);
  return read.ok && read.header.frameCount === v.frameCount ? read.header : null;
}

function validAttachment(a: AiAttachment): boolean {
  if (typeof a !== "object" || a === null || !(a.bytes instanceof Uint8Array)) return false;
  if (a.kind === "image") {
    return (
      IMAGE_MIMES.includes(a.mime) &&
      a.bytes.length > 0 &&
      a.bytes.length <= MAX_IMAGE_BYTES &&
      looksLike(a.mime, a.bytes)
    );
  }
  if (a.kind === "pdf") {
    return (
      a.bytes.length > 0 &&
      a.bytes.length <= MAX_PDF_BYTES &&
      looksLike("application/pdf", a.bytes) &&
      (a.filename === undefined || (typeof a.filename === "string" && FILE_NAME.test(a.filename)))
    );
  }
  if (a.kind === "video") return videoHeader(a) !== null;
  return false;
}

function validateText(target: AiTextTarget, request: AiRequest): TextOptions {
  const options: TextOptions = {
    maxOutputTokens: request.maxOutputTokens ?? 1024,
    reasoningEffort: request.reasoningEffort ?? "low",
  };
  const meta = target !== "spark_open";
  const efforts: readonly AiReasoningEffort[] = meta ? [...BASE_EFFORTS, "max"] : BASE_EFFORTS;
  const { messages, tools = [], replay = [], format } = request;
  if (!Array.isArray(messages) || !Array.isArray(tools) || !Array.isArray(replay)) bad();
  const attachments = messages.flatMap((m) =>
    m.role === "user" && Array.isArray(m.attachments) ? m.attachments : [],
  );
  const videos = attachments.filter((a) => a?.kind === "video").length;
  const ok =
    inRange(options.maxOutputTokens, 16, 8192) &&
    efforts.includes(options.reasoningEffort) &&
    messages.some((m) => m.role !== "system") &&
    messages.every(
      (m) =>
        typeof m.content === "string" &&
        // Only a user turn carries attachments, and only as a list.
        (m.role === "user"
          ? m.attachments === undefined || Array.isArray(m.attachments)
          : !("attachments" in m)) &&
        // Only an assistant turn carries replayed items.
        (m.role === "assistant" || !("replay" in m)) &&
        (m.role === "system" ||
          m.role === "user" ||
          (m.role === "assistant" &&
            (m.toolCalls ?? []).every(
              (c) =>
                typeof c.id === "string" &&
                CALL_ID.test(c.id) &&
                typeof c.name === "string" &&
                TOOL_NAME.test(c.name) &&
                typeof c.argumentsJson === "string",
            )) ||
          (m.role === "tool" && typeof m.toolCallId === "string" && CALL_ID.test(m.toolCallId))),
    ) &&
    tools.every(
      (t) =>
        typeof t.name === "string" &&
        TOOL_NAME.test(t.name) &&
        typeof t.description === "string" &&
        typeof t.parameters === "object" &&
        t.parameters !== null &&
        !Array.isArray(t.parameters),
    ) &&
    (format === undefined ||
      (typeof format === "object" &&
        format !== null &&
        typeof format.name === "string" &&
        FORMAT_NAME.test(format.name) &&
        typeof format.schema === "object" &&
        format.schema !== null &&
        !Array.isArray(format.schema) &&
        (format.strict === undefined || typeof format.strict === "boolean"))) &&
    attachments.length <= MAX_ATTACHMENTS &&
    attachments.every(validAttachment) &&
    // A video goes to Muse Spark only, one a call, and only from a caller that sized the call's
    // cost for it: the default maxCostCents is for text and images.
    (videos === 0 ||
      (target === "spark" && videos <= MAX_VIDEOS_PER_CALL && request.maxCostCents !== undefined)) &&
    // Structured output and attachments are not checked on Baseten yet.
    (meta || (format === undefined && attachments.length === 0)) &&
    replay.every((item) => typeof item?.type === "string" && REPLAY_TYPES.includes(item.type)) &&
    // Replayed reasoning belongs to an assistant turn, and only Meta returns it.
    (replay.length === 0 || (meta && messages.some((m) => m.role === "assistant"))) &&
    validSearchAndCache(meta, request, tools, messages, replay) &&
    validWebSearch(target, request, tools);
  if (!ok) bad();
  return options;
}

const WEB_SEARCH_CALLS: readonly number[] = [1, 2, 3];
const WEB_SEARCH_CONTEXT: readonly string[] = ["low", "medium"];

// Hosted web search: Muse Spark only, in the one shape the lookup uses. It is refused beside
// function tools, tool search and structured output, combinations this app has not measured.
function validWebSearch(target: AiTextTarget, request: AiRequest, tools: AiTool[]): boolean {
  const { webSearch } = request;
  if (webSearch === undefined) return true;
  if (target !== "spark" || typeof webSearch !== "object" || webSearch === null) return false;
  const keys = Object.keys(webSearch);
  return (
    keys.length === 2 &&
    WEB_SEARCH_CALLS.includes(webSearch.maxCalls) &&
    WEB_SEARCH_CONTEXT.includes(webSearch.contextSize) &&
    tools.length === 0 &&
    request.toolSearch !== true &&
    request.format === undefined
  );
}

// Tool search, deferred tools, the prompt cache and input-placed system messages: Meta only, and
// each in the one shape the API accepts, so a request it would refuse with a 400 is refused here
// before anything is reserved.
function validSearchAndCache(
  meta: boolean,
  request: AiRequest,
  tools: AiTool[],
  messages: AiMessage[],
  replay: AiReplayItem[],
): boolean {
  const { toolSearch, cache } = request;
  if (toolSearch !== undefined && typeof toolSearch !== "boolean") return false;
  if (!tools.every((t) => t.deferLoading === undefined || typeof t.deferLoading === "boolean")) {
    return false;
  }
  const deferred = tools.some((t) => t.deferLoading === true);
  // The API's two rules: search needs a deferred tool, and a deferred tool needs search.
  if (toolSearch === true && (!meta || !deferred)) return false;
  if (deferred && toolSearch !== true) return false;
  if (tools.some((t) => t.name === TOOL_SEARCH_NAME)) return false;
  if (cache !== undefined) {
    if (!meta || typeof cache !== "object" || cache === null) return false;
    if (typeof cache.key !== "string" || !CACHE_KEY.test(cache.key)) return false;
    if (cache.retention !== undefined && cache.retention !== "in_memory" && cache.retention !== "24h") {
      return false;
    }
  }
  const placementsOk = messages.every((m) =>
    m.role === "system"
      ? m.placement === undefined ||
        m.placement === "instructions" ||
        // Chat Completions has no equivalent of a system item placed in input.
        (m.placement === "input" && meta)
      : !("placement" in m),
  );
  if (!placementsOk) return false;
  // An assistant turn's own items are its tool search items only, and come back only from a
  // request that offered the search tool.
  const pinnedOk = messages.every(
    (m) =>
      m.role !== "assistant" ||
      m.replay === undefined ||
      (toolSearch === true &&
        Array.isArray(m.replay) &&
        m.replay.every((item) => item?.type === "tool_search_call" || item?.type === "tool_search_output")),
  );
  if (!pinnedOk) return false;
  // Tool search items come back only from a request that offered the search tool.
  return toolSearch === true || replay.every((item) => item.type === "reasoning");
}

// Where each host's text call goes and how its answer is read.
const TEXT_HOSTS: Record<
  AiProvider,
  { url: string; parse: (json: unknown, httpStatus: number) => CallOutcome }
> = {
  meta: { url: META_RESPONSES_URL, parse: parseMeta },
  baseten: { url: BASETEN_CHAT_URL, parse: parseBaseten },
  fireworks: { url: FIREWORKS_CHAT_URL, parse: parseFireworks },
};

// A text call's plan for one host: its body, its reserve and how its answer is read. complete()
// sends it; spendRoom() reads only its reserve, so the two always reserve the same amount.
function textPlan(target: AiTextTarget, request: AiRequest): PlanFn<TextAnswer, "tokens"> {
  return (model, price, provider) => {
    const options = validateText(target, request);
    const meta = provider === "meta";
    // Fireworks takes Baseten's body: the same OpenAI chat shape.
    const body = JSON.stringify(
      meta
        ? metaBody(model, request, options)
        : basetenBody(model, request, { maxOutputTokens: options.maxOutputTokens }),
    );
    // The reserve counts the request's text, not its attachment data: each image and each
    // PDF page is reserved at its own token figure instead.
    let attachmentChars = 0;
    let images = 0;
    let pages = 0;
    let video: { frames: number; durationMs: number } | null = null;
    for (const m of request.messages) {
      if (m.role !== "user") continue;
      for (const a of m.attachments ?? []) {
        const mime = a.kind === "pdf" ? "application/pdf" : a.mime;
        attachmentChars += dataUrlLength(mime, a.bytes.length);
        if (a.kind === "image") images += 1;
        else if (a.kind === "video") {
          // validateText already read this header; at most one video per call.
          const header = videoHeader(a);
          if (!header) bad();
          video = { frames: header.frameCount, durationMs: header.durationMs };
        } else pages += pdfPages(a.bytes);
      }
    }
    const textBytes = new TextEncoder().encode(body).length - attachmentChars;
    // Only a Meta request carries a search; the standby host never gets one.
    const searches = meta && request.webSearch ? request.webSearch.maxCalls : 0;
    const searched = meta && (request.toolSearch === true || searches > 0);
    return {
      url: TEXT_HOSTS[provider].url,
      body,
      reserveNanocents:
        estimateReserve(
          price,
          searched ? textBytes * SEARCH_INPUT_FACTOR : textBytes,
          options.maxOutputTokens,
          // Each web search the request allows: the pages it returns, read as input.
          mediaReserveTokens(images, pages, video) + searches * WEB_SEARCH_RESERVE_TOKENS,
        ) +
        // And the search itself, billed per search.
        searches * WEB_SEARCH_QUERY_NANOCENTS,
      // Baseten and Fireworks take no reasoning setting, so none is recorded for them.
      reasoningEffort: meta ? options.reasoningEffort : null,
      parse: TEXT_HOSTS[provider].parse,
    };
  };
}

export async function complete(
  target: AiTextTarget,
  request: AiRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<AiResult> {
  if (!TEXT_TARGETS.includes(target)) bad();
  const { callId, answer, costNanocents } = await runCall(
    target,
    "tokens",
    request,
    DEFAULT_TIMEOUT_MS,
    session,
    deps,
    textPlan(target, request),
  );
  if (answer.metered.unit !== "tokens") throw new AiError("unknown");
  return {
    callId,
    status: answer.status,
    text: answer.value.text,
    toolCalls: answer.value.toolCalls,
    usage: answer.metered.usage,
    costNanocents,
    upstreamId: answer.upstreamId,
    replay: answer.value.replay,
    toolSearches: answer.value.toolSearches,
    // A request that offered web search always gets the web part back, empty when none ran.
    ...(request.webSearch
      ? {
          web: answer.value.web ?? {
            answerText: answer.value.text,
            citations: [],
            searchResults: [],
            searchCalls: 0,
          },
        }
      : {}),
    ...(answer.value.reasoningSummary ? { reasoningSummary: answer.value.reasoningSummary } : {}),
  };
}

export type SpendRoom = "room" | "cap" | "too_expensive";

// What complete(target, request) would meet at its spend checks right now, read with one SELECT
// of the counter and no lock and no write: the caps, job allowance, model, price and reserve
// runCall uses, then prepare's maxCostCents and job allowance test ("too_expensive") and the
// reserve's own cap test ("cap"). Null when the call would be refused for another reason first
// (the switch, the configuration, a job allowance that is not a positive whole number of cents,
// a malformed request): the call then answers for itself. A counter that cannot be read throws,
// as at the reserve. Nothing is held, so a call that starts after this read can still take the
// room; the reserve, under its lock, stays the real stop. Muse Spark Open's standby host is not
// checked.
export async function spendRoom(
  target: AiTextTarget,
  request: AiRequest,
  q: Queryable,
): Promise<SpendRoom | null> {
  if (!flags.aiEnabled || !TEXT_TARGETS.includes(target)) return null;
  const { cap, wonderCap } = capsFor(target);
  const jobCap = jobCapNanocents(flags.aiJobHourlyCapCents);
  const configured = modelFor(target, "tokens");
  if (
    cap === null ||
    jobCap === null ||
    (target === "wonder" && wonderCap === null) ||
    contributorRefusesAll(process.env) ||
    !configured
  ) {
    return null;
  }
  let reserveNanocents: number;
  let c: Common;
  try {
    c = common(request, DEFAULT_TIMEOUT_MS);
    reserveNanocents = textPlan(target, request)(
      configured.model,
      configured.price,
      TARGETS[target].provider,
    ).reserveNanocents;
  } catch (err) {
    if (err instanceof AiError) return null;
    throw err;
  }
  if (overCallCost(reserveNanocents, c) || reserveNanocents > jobCap) return "too_expensive";
  const refused = overCap(await readSpend(q), {
    target,
    reserveNanocents,
    capNanocents: cap,
    wonderCapNanocents: wonderCap,
  });
  return refused ? "cap" : "room";
}

// --- computerStep: one step of a computer-use loop, on the model flags.portalRunnerModel names ---

// The docs' limit for a stateless replay: at most 29 calls and their answers in one request.
const MAX_COMPUTER_PAIRS = 29;
const MAX_INSTRUCTIONS_CHARS = 20_000;
const MAX_TASK_CHARS = 4_000;
const MAX_ACKNOWLEDGED = 8;
const SCREENSHOT_MIMES: readonly string[] = ["image/png", "image/jpeg"];

function validScreenshot(s: ComputerScreenshot): boolean {
  return (
    typeof s === "object" &&
    s !== null &&
    SCREENSHOT_MIMES.includes(s.mime) &&
    s.bytes instanceof Uint8Array &&
    s.bytes.length > 0 &&
    s.bytes.length <= MAX_IMAGE_BYTES &&
    looksLike(s.mime, s.bytes)
  );
}

function validPair(p: ComputerPair): boolean {
  if (typeof p !== "object" || p === null) return false;
  const call = p.call;
  const output = p.output;
  return (
    typeof call === "object" &&
    call !== null &&
    !Array.isArray(call) &&
    call.type === "computer_call" &&
    typeof call.call_id === "string" &&
    typeof output === "object" &&
    output !== null &&
    output.callId === call.call_id &&
    validScreenshot(output.screenshot) &&
    Array.isArray(output.acknowledged) &&
    output.acknowledged.length <= MAX_ACKNOWLEDGED &&
    output.acknowledged.every(
      (c) => typeof c === "object" && c !== null && typeof c.id === "string" && c.id !== "",
    )
  );
}

// The caller acts on result.call: it validates the actions, and it never runs any of them while
// call.pendingSafetyChecks is non-empty. The wrapper only carries the checks; it never fills
// acknowledged itself.
export async function computerStep(
  target: "wonder" | "spark",
  request: ComputerRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<ComputerResult> {
  // Only the model the switch names, read on every call: any other target is refused before any
  // reservation, whichever of the two it is.
  if ((target !== "wonder" && target !== "spark") || target !== flags.portalRunnerModel) bad();
  const { callId, answer, costNanocents } = await runCall(
    target,
    "tokens",
    request,
    SLOW_TIMEOUT_MS,
    session,
    deps,
    (model, price, provider) => {
      // The computer tool is a Meta Responses feature; no other host is ever sent this body.
      if (provider !== "meta") bad();
      const options: TextOptions = {
        maxOutputTokens: request.maxOutputTokens ?? 1024,
        reasoningEffort: request.reasoningEffort ?? "medium",
      };
      const history = request.history;
      if (
        !inRange(options.maxOutputTokens, 16, 8192) ||
        ![...BASE_EFFORTS, "max"].includes(options.reasoningEffort) ||
        typeof request.instructions !== "string" ||
        request.instructions.trim() === "" ||
        request.instructions.length > MAX_INSTRUCTIONS_CHARS ||
        typeof request.task !== "string" ||
        request.task.trim() === "" ||
        request.task.length > MAX_TASK_CHARS ||
        !validScreenshot(request.screenshot) ||
        !Array.isArray(history) ||
        history.length > MAX_COMPUTER_PAIRS ||
        !history.every(validPair)
      ) {
        bad();
      }
      const body = JSON.stringify(metaComputerBody(model, request, options));
      // The text is reserved at its byte count; each screenshot at its own token figure; the
      // computer tool at the tokens the platform adds for it.
      const screenshots = [request.screenshot, ...history.map((p) => p.output.screenshot)];
      const imageChars = screenshots.reduce((n, s) => n + dataUrlLength(s.mime, s.bytes.length), 0);
      const textBytes = new TextEncoder().encode(body).length - imageChars;
      return {
        url: META_RESPONSES_URL,
        body,
        reserveNanocents: estimateReserve(
          price,
          textBytes,
          options.maxOutputTokens,
          screenshots.length * SCREENSHOT_RESERVE_TOKENS + COMPUTER_TOOL_RESERVE_TOKENS,
        ),
        reasoningEffort: options.reasoningEffort,
        parse: parseMeta,
      };
    },
  );
  if (answer.metered.unit !== "tokens") throw new AiError("unknown");
  return {
    callId,
    status: answer.status,
    text: answer.value.text,
    toolCalls: answer.value.toolCalls,
    usage: answer.metered.usage,
    costNanocents,
    upstreamId: answer.upstreamId,
    replay: answer.value.replay,
    toolSearches: answer.value.toolSearches,
    call: answer.value.computerCall ?? null,
  };
}

// --- transcribe: Muse Voice Transcribe ---

export async function transcribe(
  request: TranscribeRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<TranscribeResult> {
  const { callId, answer, costNanocents } = await runCall(
    "voice",
    "audio_seconds",
    request,
    SLOW_TIMEOUT_MS,
    session,
    deps,
    (model, price) => {
      const mode = request.mode ?? "PUSH_TO_TALK";
      const languageBias = request.languageBias ?? [];
      const keywords = request.keywords ?? [];
      const wav = request.wav instanceof Uint8Array ? readWav(request.wav) : null;
      if (
        !wav ||
        (mode !== "PUSH_TO_TALK" && mode !== "ENDPOINTING") ||
        !Array.isArray(languageBias) ||
        !languageBias.every((l) => LANGUAGES.includes(l)) ||
        new Set(languageBias).size !== languageBias.length ||
        !Array.isArray(keywords) ||
        keywords.length > MAX_KEYWORDS ||
        !keywords.every((k) => typeof k === "string" && KEYWORD.test(k) && k.trim() === k)
      ) {
        bad();
      }
      return {
        url: META_TRANSCRIBE_URL,
        accept: META_TRANSCRIBE_ACCEPT,
        body: voiceBody(model, request.wav, { mode, languageBias, keywords }),
        reserveNanocents: audioReserve(price.perSecond, wav.samples, wav.sampleRate),
        reasoningEffort: null,
        parse: parseVoice,
      };
    },
  );
  return {
    callId,
    transcript: answer.value.transcript,
    turns: answer.value.turns,
    audioDurationMs: answer.value.audioDurationMs,
    costNanocents,
  };
}

// --- generateImage: Muse Image ---

function validSize(size: unknown): boolean {
  if (typeof size !== "string") return false;
  const m = SIZE.exec(size);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return Math.max(w, h) <= MAX_ASPECT * Math.min(w, h);
}

export async function generateImage(
  request: ImageRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<ImageResult> {
  const outputFormat = request.outputFormat ?? "png";
  const { callId, answer, costNanocents } = await runCall(
    "image",
    "images",
    request,
    SLOW_TIMEOUT_MS,
    session,
    deps,
    (model, price) => {
      const n = request.n ?? 1;
      const reasoningStrength = request.reasoningStrength ?? "high";
      if (
        typeof request.prompt !== "string" ||
        request.prompt.trim() === "" ||
        request.prompt.length > MAX_PROMPT_CHARS ||
        !inRange(n, 1, MAX_IMAGES_PER_CALL) ||
        (request.size !== undefined && !validSize(request.size)) ||
        !IMAGE_FORMATS.includes(outputFormat) ||
        (reasoningStrength !== "low" && reasoningStrength !== "high")
      ) {
        bad();
      }
      return {
        url: META_IMAGES_URL,
        body: JSON.stringify(
          imageBody(model, request.prompt, {
            n,
            size: request.size ?? null,
            outputFormat,
            reasoningStrength,
          }),
        ),
        reserveNanocents: n * price.perImage,
        reasoningEffort: null,
        parse: parseImage(outputFormat, n),
      };
    },
  );
  return { callId, images: answer.value, costNanocents };
}

// --- segment: SAM 3.1 ---

export async function segment(
  request: SegmentRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<SegmentResult> {
  const { callId, answer, costNanocents } = await runCall(
    "sam",
    "segmentation",
    request,
    DEFAULT_TIMEOUT_MS,
    session,
    deps,
    (model, price) => {
      const image = request.image;
      const maskEncoding = request.maskEncoding ?? "lossless";
      const includeConfidence = request.includeConfidence ?? true;
      if (
        typeof image !== "object" ||
        image === null ||
        !(image.bytes instanceof Uint8Array) ||
        !IMAGE_MIMES.includes(image.mime) ||
        image.bytes.length === 0 ||
        image.bytes.length > MAX_IMAGE_BYTES ||
        !looksLike(image.mime, image.bytes) ||
        typeof request.prompt !== "string" ||
        !SAM_PROMPT.test(request.prompt) ||
        (maskEncoding !== "lossless" && maskEncoding !== "one_bit") ||
        typeof includeConfidence !== "boolean"
      ) {
        bad();
      }
      return {
        url: META_RESPONSES_URL,
        body: JSON.stringify(
          samBody(model, image, request.prompt, { maskEncoding, includeConfidence }),
        ),
        // One image, matched or not.
        reserveNanocents: price.perImage,
        reasoningEffort: null,
        parse: parseSam,
      };
    },
  );
  return {
    callId,
    imageWidth: answer.value.imageWidth,
    imageHeight: answer.value.imageHeight,
    matches: answer.value.matches,
    costNanocents,
  };
}

// --- segmentVideo: SAM 3.1 tracking through a video ---

export async function segmentVideo(
  request: SegmentVideoRequest,
  session: Session,
  deps: AiDeps = {},
): Promise<SegmentVideoResult> {
  const { callId, answer, costNanocents } = await runCall(
    "sam",
    "segmentation",
    request,
    SEGMENT_VIDEO_TIMEOUT_MS,
    session,
    deps,
    (model, price) => {
      const header = videoHeader(request.video);
      const propagation = request.propagation ?? "both";
      const maskEncoding = request.maskEncoding ?? "one_bit";
      const includeConfidence = request.includeConfidence ?? true;
      if (
        !header ||
        typeof request.prompt !== "string" ||
        !SAM_PROMPT.test(request.prompt) ||
        (propagation !== "both" && propagation !== "forward" && propagation !== "backward") ||
        (maskEncoding !== "lossless" && maskEncoding !== "one_bit") ||
        typeof includeConfidence !== "boolean"
      ) {
        bad();
      }
      return {
        url: META_RESPONSES_URL,
        body: JSON.stringify(
          samVideoBody(model, request.video, request.prompt, {
            maskEncoding,
            includeConfidence,
            propagation,
          }),
        ),
        // Every frame of the clip, never under the per-request floor.
        reserveNanocents: videoFramesCost(price, header.frameCount),
        reasoningEffort: null,
        parse: parseSamVideo(header.frameCount - 1, price.minFrames),
      };
    },
  );
  if (answer.metered.unit !== "video_frames") throw new AiError("unknown");
  return {
    callId,
    frames: answer.value.frames,
    width: answer.value.width,
    height: answer.value.height,
    framesProcessed: answer.value.framesProcessed,
    costNanocents,
  };
}
