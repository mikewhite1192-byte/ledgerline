import { flags } from "../../config/flags";
import { AiError, complete, type AiAttachment, type AiDeps, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { prepareImage } from "./prepare";
import { DOCUMENT_FORMAT, DOCUMENT_PROMPT, parseRead } from "./schema";
import type { DocumentMime, DocumentRead } from "./types";

// One Muse Spark 1.3 read of one uploaded file, under the strict document schema. The model only
// fills fields; what it returns is a claim. Every failure is a category: budget (the demo's cap,
// a call too expensive, the provider's billing) or unreadable (anything else, including a cut
// answer or one off the schema). The raw error never leaves this file; the log gets its name.

export const READ_MAX_OUTPUT_TOKENS = 1_200;
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
  | { ok: false; status: "unreadable" | "budget"; category: ReadFailureCategory; callId: string | null };

// The model call, as this module needs it. The default is complete() with the given AiDeps.
export type ReadComplete = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type ReadDeps = { complete?: ReadComplete; ai?: AiDeps };

export type ReadInput = {
  documentId: string;
  bytes: Uint8Array;
  mime: DocumentMime;
  traceId: string;
};

const BUDGET: readonly string[] = ["cap", "too_expensive", "billing"];

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
  let bytes = input.bytes;
  let mime = input.mime;
  if (flags.documentCrop && mime !== "application/pdf") {
    const prepared = await prepareImage(bytes, mime);
    bytes = prepared.bytes;
    mime = prepared.mime;
  }
  let result: AiResult;
  try {
    result = await call(
      "spark",
      {
        messages: [
          { role: "system", content: DOCUMENT_PROMPT },
          { role: "user", content: "Read this document.", attachments: [attachmentOf(bytes, mime)] },
        ],
        format: DOCUMENT_FORMAT,
        maxOutputTokens: READ_MAX_OUTPUT_TOKENS,
        reasoningEffort: "low",
        purpose: "document_read",
        maxCostCents: flags.documentLimits.readMaxCostCents,
        timeoutMs: READ_TIMEOUT_MS,
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
      return { ok: false, status: "unreadable", category: "model_error", callId: null };
    }
    console.error(`documents: read ${input.documentId} failed error=${(err as Error)?.name ?? "unknown"}`);
    return { ok: false, status: "unreadable", category: "error", callId: null };
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
