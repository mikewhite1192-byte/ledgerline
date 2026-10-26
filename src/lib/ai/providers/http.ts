import type { AiFailureCategory, AiUsage, CallOutcome } from "../types";

// One JSON POST to a model provider. Only fetch is injected, so tests never reach the network.
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type HttpCall = { url: string; key: string; body: string; timeoutMs: number };

// The documented codes (https://dev.meta.ai/docs/error-handling); Baseten is OpenAI-compatible
// and uses the same ones. 403 is not documented and reads as a key problem.
export function categoryForStatus(status: number): AiFailureCategory {
  switch (status) {
    case 400:
    case 404:
      return "bad_request";
    case 401:
    case 403:
      return "auth";
    case 402:
      return "billing";
    case 413:
      return "too_long";
    case 429:
      return "rate_limited";
    case 504:
      return "timeout";
    default:
      return status >= 500 && status <= 599 ? "unavailable" : "unknown";
  }
}

// Documented refusals that are never charged: the reservation is released. Every other non-200
// may have been charged (a 5xx after the model ran), so its reservation stays counted. Nothing
// is retried: a retry doubles the charge, and a 402 (out of credit) does not pass on its own.
const DEFINITE_REFUSALS = new Set([400, 401, 402, 404, 413, 429]);

// Never throws. Retry-After is ignored (the caller shows "try again"). An upstream message never
// reaches a log, the ledger or a page: an error body is discarded unread.
export async function post(
  fetchFn: FetchFn,
  call: HttpCall,
  parse: (json: unknown, httpStatus: number) => CallOutcome,
): Promise<CallOutcome> {
  let response: Response;
  try {
    response = await fetchFn(call.url, {
      method: "POST",
      headers: { authorization: `Bearer ${call.key}`, "content-type": "application/json" },
      body: call.body,
      // The timeout covers reading the body too.
      signal: AbortSignal.timeout(call.timeoutMs),
      // A redirect would carry the key somewhere else.
      redirect: "error",
      cache: "no-store",
    });
  } catch (err) {
    return { kind: "unknown", category: isTimeout(err) ? "timeout" : "network", httpStatus: null };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    const category = categoryForStatus(response.status);
    return DEFINITE_REFUSALS.has(response.status)
      ? { kind: "refused", category, httpStatus: response.status }
      : { kind: "unknown", category, httpStatus: response.status };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { kind: "unknown", category: isTimeout(err) ? "timeout" : "unknown", httpStatus: 200 };
  }
  return parse(json, 200);
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const MAX_INT = 2_147_483_647;

function count(value: unknown, fallback?: number): number | null {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT
    ? value
    : null;
}

// Token counts as the ledger stores them, or null when the provider's numbers are missing or do
// not add up (an answer with no usable usage is settled as unknown, never as free).
export function usageFrom(
  input: unknown,
  cached: unknown,
  output: unknown,
  reasoning: unknown,
): AiUsage | null {
  const i = count(input);
  const c = count(cached, 0);
  const o = count(output);
  const r = count(reasoning, 0);
  if (i === null || c === null || o === null || r === null) return null;
  if (c > i || r > o) return null;
  return { input: i, cached: c, output: o, reasoning: r };
}

// Response ids are logged and stored, so only a plain token of bounded length is kept.
export function upstreamIdFrom(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : null;
}
