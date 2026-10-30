import { flags } from "../../config/flags";
import { AiError, complete, type AiAttachment, type AiDeps, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { DOCUMENT_FORMAT, DOCUMENT_PROMPT, parseRead } from "./schema";
import type { DocumentMime, DocumentRead } from "./types";

// One Muse Spark 1.3 read of one uploaded file, under the strict document schema. The model only
// fills fields; what it returns is a claim. Every failure is a category: budget (the demo's cap,
// a call too expensive, the provider's billing), retry (an outcome that is not known or may pass
// on its own: a timeout, a 5xx, a network error, a busy provider, an unexpected error), so the
// row stays pending for Read again, or unreadable (a definite failure, including a cut answer or
// one off the schema). The raw error never leaves this file; the log gets its name.

// Room for the schema's largest answer: 80 lines of 160 characters, every field at its longest,
// four stops and the confidences come to about 14,610 characters of JSON, 7,305 tokens even at
// two characters a token (English runs nearer four), so this, the most the AI wrapper allows,
// leaves room for low effort reasoning. Its worst case reserve at Muse Spark's standard price,
// for a 3 page PDF (4,000 tokens a page) and about 3,500 bytes of prompt and schema (1,763
// tokens at two bytes a token), is (1,763 + 12,000) x 125,000 + 8,192 x 425,000 =
// 5,201,975,000 nanocents, 5.2 cents, under flags.documentLimits.readMaxCostCents (8).
// read.test.ts pins both.
export const READ_MAX_OUTPUT_TOKENS = 8_192;
export const READ_TIMEOUT_MS = 25_000;

export type ReadFailureCategory =
  | "disabled"
  | "cap"
  | "too_expensive"
  | "billing"
  | "incomplete"
  | "schema"
  | "model_error"
  | "error";

export type ReadOutcome =
  | { ok: true; read: DocumentRead; callId: string; costNanocents: number }
  | { ok: false; status: "unreadable" | "budget"; category: ReadFailureCategory; callId: string | null }
  | { ok: false; status: "retry"; category: "model_error" | "error"; callId: null };

// The model call, as this module needs it. The default is complete() with the given AiDeps.
export type ReadComplete = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type ReadDeps = { complete?: ReadComplete; ai?: AiDeps };

export type ReadInput = {
  documentId: string;
  bytes: Uint8Array;
  mime: DocumentMime;
  traceId: string;
  // What the request has left for this read; held to 1 ms to READ_TIMEOUT_MS, which is also the
  // default.
  timeoutMs?: number;
};

function timeoutOf(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return READ_TIMEOUT_MS;
  return Math.min(READ_TIMEOUT_MS, Math.max(1, Math.floor(ms)));
}

const BUDGET: readonly string[] = ["cap", "too_expensive", "billing"];
// Not known (the provider may have answered) or likely to pass later: never a final state.
const RETRY: readonly string[] = ["timeout", "unavailable", "network", "unknown", "rate_limited"];

function attachmentOf(bytes: Uint8Array, mime: DocumentMime): AiAttachment {
  if (mime === "application/pdf") return { kind: "pdf", bytes, filename: "document.pdf" };
  return { kind: "image", mime, bytes };
}

export async function readDocument(
  input: ReadInput,
  session: Session,
  deps: ReadDeps = {},
): Promise<ReadOutcome> {
  // The switch is re-read here, at the outside call, whatever the route already checked.
  if (!flags.documentsEnabled) {
    return { ok: false, status: "unreadable", category: "disabled", callId: null };
  }
  const call: ReadComplete = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  let result: AiResult;
  try {
    result = await call(
      "spark",
      {
        messages: [
          { role: "system", content: DOCUMENT_PROMPT },
          { role: "user", content: "Read this document.", attachments: [attachmentOf(input.bytes, input.mime)] },
        ],
        format: DOCUMENT_FORMAT,
        maxOutputTokens: READ_MAX_OUTPUT_TOKENS,
        reasoningEffort: "low",
        purpose: "document_read",
        maxCostCents: flags.documentLimits.readMaxCostCents,
        timeoutMs: timeoutOf(input.timeoutMs),
        traceId: input.traceId,
      },
      session,
    );
  } catch (err) {
    if (err instanceof AiError) {
      console.error(`documents: read ${input.documentId} failed category=${err.category}`);
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
    console.error(`documents: read ${input.documentId} failed error=${(err as Error)?.name ?? "unknown"}`);
    return { ok: false, status: "retry", category: "error", callId: null };
  }
  if (result.status !== "ok") {
    console.error(`documents: read ${input.documentId} failed category=incomplete`);
    return { ok: false, status: "unreadable", category: "incomplete", callId: result.callId };
  }
  const read = parseRead(result.text);
  if (!read) {
    console.error(`documents: read ${input.documentId} failed category=schema`);
    return { ok: false, status: "unreadable", category: "schema", callId: result.callId };
  }
  return { ok: true, read, callId: result.callId, costNanocents: result.costNanocents };
}
