import { flags } from "../../config/flags";
import { AiError, complete, type AiDeps, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { parseRateCon, RATECON_FORMAT, RATECON_PROMPT, type RateConReading } from "./schema";

// The second Muse Spark 1.3 read of one uploaded rate confirmation, under the strict rate
// confirmation schema (src/lib/ratecon/schema.ts). The model only fills fields; what it returns is
// a claim the checks in check.ts decide on. Every failure is a category, as in the first read
// (src/lib/documents/read.ts): budget (the demo's cap, a call too expensive, the provider's
// billing), retry (an outcome that is not known or may pass on its own: a timeout, a 5xx, a network
// error, a busy provider, an unexpected error), so the reading stays pending and can be tried
// again, or unreadable (a definite failure, including a cut answer or one off the schema). The raw
// error never leaves this file; the log gets its category or its name.

// Room for the schema's largest answer: 80 lines of 160 characters, every field at its longest and
// six charge lines come to about 15,600 characters of JSON, 7,800 tokens even at two characters a
// token (English runs nearer four), so this, the most the AI wrapper allows, leaves room for low
// effort reasoning. Its worst case reserve at Muse Spark's standard price, for a 3 page PDF (4,000
// tokens a page) and about 3,600 bytes of prompt and schema (1,800 tokens at two bytes a token), is
// (1,800 + 12,000) x 125,000 + 8,192 x 425,000 = 5,206,600,000 nanocents, 5.2 cents, under
// flags.ratecon.readMaxCostCents (8). read.test.ts pins both and measures the reserve.
export const RATECON_MAX_OUTPUT_TOKENS = 8_192;
export const RATECON_TIMEOUT_MS = 25_000;

export type RateConReadCategory =
  | "disabled"
  | "cap"
  | "too_expensive"
  | "billing"
  | "incomplete"
  | "schema"
  | "model_error"
  | "error";

export type RateConReadOutcome =
  | { ok: true; reading: RateConReading; callId: string; costNanocents: number }
  | { ok: false; status: "unreadable" | "budget"; category: RateConReadCategory; callId: string | null }
  | { ok: false; status: "retry"; category: "disabled" | "model_error" | "error"; callId: null };

// The model call, as this module needs it. The default is complete() with the given AiDeps.
export type RateConComplete = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type RateConReadDeps = { complete?: RateConComplete; ai?: AiDeps };

export type RateConReadInput = {
  documentId: string;
  bytes: Uint8Array;
  traceId: string;
};

const BUDGET: readonly string[] = ["cap", "too_expensive", "billing"];
// Not known (the provider may have answered) or likely to pass later: never a final state.
const RETRY: readonly string[] = ["timeout", "unavailable", "network", "unknown", "rate_limited"];

// Only a PDF is read as a rate confirmation (service.ts refuses any other file before the call).
export async function readRateCon(
  input: RateConReadInput,
  session: Session,
  deps: RateConReadDeps = {},
): Promise<RateConReadOutcome> {
  // Both switches are re-read here, at the outside call, whatever the route already checked. No
  // call is made, so the reading is left pending: a switch turned off never ends it.
  if (!flags.documentsEnabled || !flags.ratecon.enabled) {
    return { ok: false, status: "retry", category: "disabled", callId: null };
  }
  const call: RateConComplete = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  let result: AiResult;
  try {
    result = await call(
      "spark",
      {
        messages: [
          { role: "system", content: RATECON_PROMPT },
          {
            role: "user",
            content: "Read this rate confirmation.",
            attachments: [{ kind: "pdf", bytes: input.bytes, filename: "rate-confirmation.pdf" }],
          },
        ],
        format: RATECON_FORMAT,
        maxOutputTokens: RATECON_MAX_OUTPUT_TOKENS,
        reasoningEffort: "low",
        purpose: "ratecon_read",
        maxCostCents: flags.ratecon.readMaxCostCents,
        timeoutMs: RATECON_TIMEOUT_MS,
        traceId: input.traceId,
      },
      session,
    );
  } catch (err) {
    if (err instanceof AiError) {
      console.error(`ratecon: read ${input.documentId} failed category=${err.category}`);
      if (BUDGET.includes(err.category)) {
        return {
          ok: false,
          status: "budget",
          category: err.category as "cap" | "too_expensive" | "billing",
          callId: null,
        };
      }
      if (RETRY.includes(err.category)) return { ok: false, status: "retry", category: "model_error", callId: null };
      return { ok: false, status: "unreadable", category: "model_error", callId: null };
    }
    console.error(`ratecon: read ${input.documentId} failed error=${(err as Error)?.name ?? "unknown"}`);
    return { ok: false, status: "retry", category: "error", callId: null };
  }
  if (result.status !== "ok") {
    console.error(`ratecon: read ${input.documentId} failed category=incomplete`);
    return { ok: false, status: "unreadable", category: "incomplete", callId: result.callId };
  }
  const reading = parseRateCon(result.text);
  if (!reading) {
    console.error(`ratecon: read ${input.documentId} failed category=schema`);
    return { ok: false, status: "unreadable", category: "schema", callId: result.callId };
  }
  return { ok: true, reading, callId: result.callId, costNanocents: result.costNanocents };
}
