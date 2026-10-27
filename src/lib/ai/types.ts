// The wrapper's shapes. Every runtime model call goes through ./index.ts (complete, transcribe,
// generateImage, segment); agent code sees these types and nothing provider-specific.

export type AiProvider = "meta" | "baseten";

// A call names the model slot it wants, not a provider. ./targets.ts maps each to its provider,
// the variable that holds its model id, and its price.
export type AiTarget = "spark" | "wonder" | "spark_open" | "voice" | "image" | "sam";

// The targets complete() accepts.
export type AiTextTarget = "spark" | "wonder" | "spark_open";

// What sort of call a ledger row records.
export type AiCallKind = "text" | "transcribe" | "image" | "segment";

// "max" is accepted by Muse Spark 1.3 and Muse Wonder only.
export type AiReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AiToolCall = { id: string; name: string; argumentsJson: string };

export type AiImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// Sent inline (a base64 data URL), never through an upload API, so nothing is kept upstream.
export type AiAttachment =
  | { kind: "image"; mime: AiImageMime; bytes: Uint8Array }
  | { kind: "pdf"; bytes: Uint8Array; filename?: string };

export type AiMessage =
  // A system message. placement "input" (Meta targets only) sends it as a system-role item in
  // input at its position instead of joining it into instructions, so the text before it can
  // stay a shared, cacheable prefix. Default "instructions".
  | { role: "system"; content: string; placement?: "instructions" | "input" }
  // A user turn, with any images or PDFs it carries.
  | { role: "user"; content: string; attachments?: AiAttachment[] }
  // An assistant turn: its text and the tool calls it made, if any. replay (Meta, with toolSearch
  // on) holds the hosted tool search items that answer produced, sent back just before it on every
  // later call so a tool it loaded stays loaded; only tool_search_call and tool_search_output.
  | { role: "assistant"; content: string; toolCalls?: AiToolCall[]; replay?: AiReplayItem[] }
  // The result of one tool call, matched to it by id.
  | { role: "tool"; content: string; toolCallId: string };

// parameters is a JSON Schema object. deferLoading (Meta targets, with toolSearch on) sends only
// the name and description until the model searches for the tool.
export type AiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferLoading?: boolean;
};

// Meta's automatic prefix caching: one stable key shared by every request with the same prefix.
// "in_memory" is the API's default and is never sent; "24h" asks for longer retention.
export type AiCacheOptions = { key: string; retention?: "in_memory" | "24h" };

// Structured output: the reply is constrained to this JSON Schema. The wrapper returns the JSON
// as text and never parses it; the caller does.
export type AiFormat = { name: string; schema: Record<string, unknown>; strict?: boolean };

// Opaque provider items from the previous turn (Meta's encrypted reasoning, and the hosted tool
// search's call and output), sent back unchanged so the model keeps its reasoning and the tools
// it loaded across a tool loop. Never stored, never logged.
export type AiReplayItem = {
  readonly type: "reasoning" | "tool_search_call" | "tool_search_output";
} & Record<string, unknown>;

// What every call takes besides its own input.
export type AiCallOptions = {
  // What the call is for, recorded in the ledger: lower case, digits and underscores, 3 to 40.
  purpose: string;
  // The call is refused if its worst-case cost is above this. Default 25.
  maxCostCents?: number;
  // At most 60,000. Default 25,000; 60,000 for transcribe and generateImage.
  timeoutMs?: number;
  // Groups the calls behind one answer in the ledger. A UUID.
  traceId?: string;
};

export type AiRequest = AiCallOptions & {
  messages: AiMessage[];
  tools?: AiTool[];
  format?: AiFormat;
  // Reasoning and visible text together. Default 1024, 16 to 8192.
  maxOutputTokens?: number;
  // Meta targets only. Default "low".
  reasoningEffort?: AiReasoningEffort;
  // The last answer's items, in the order returned, sent just before the last assistant turn
  // (where they stand in for that turn's own replay).
  replay?: AiReplayItem[];
  // Meta targets only: offer the hosted tool_search tool. Requires at least one deferLoading
  // tool, and every deferLoading tool requires it.
  toolSearch?: boolean;
  // Meta targets only.
  cache?: AiCacheOptions;
};

export type AiUsage = { input: number; cached: number; output: number; reasoning: number };

export type AiResult = {
  callId: string;
  // incomplete: the model ran out of output budget (reasoning counts against it). The text may
  // be empty or cut short; the call is still charged.
  status: "ok" | "incomplete";
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
  costNanocents: number;
  upstreamId: string | null;
  replay: AiReplayItem[];
  // How many hosted tool searches the model ran inside this answer.
  toolSearches: number;
};

// Language names, not codes: what the transcription API takes. A hint only.
export type AiLanguage = "English" | "Spanish";

export type TranscribeRequest = AiCallOptions & {
  // RIFF/WAVE, mono, 16-bit PCM, 16,000 or 24,000 Hz, at most 600 seconds and 20 MB.
  wav: Uint8Array;
  // PUSH_TO_TALK (default): one turn. ENDPOINTING: turns split at pauses.
  mode?: "PUSH_TO_TALK" | "ENDPOINTING";
  languageBias?: AiLanguage[];
  // Words to listen for (names, places). At most 20, each 1 to 50 characters.
  keywords?: string[];
};

export type TranscribeTurn = { startMs: number; endMs: number; transcript: string };

export type TranscribeResult = {
  callId: string;
  transcript: string;
  turns: TranscribeTurn[];
  audioDurationMs: number;
  costNanocents: number;
};

export type ImageRequest = AiCallOptions & {
  // Sent, never stored or logged. 1 to 4,000 characters.
  prompt: string;
  // 1 to 4. Default 1.
  n?: number;
  // An aspect ratio as "WxH" (the pixel size is the model's own). Default: the model's.
  size?: string;
  // Default "png".
  outputFormat?: "png" | "jpeg" | "webp";
  // Default "high", the API's own default. The price is the same either way.
  reasoningStrength?: "low" | "high";
};

export type ImageResult = {
  callId: string;
  images: { bytes: Uint8Array; mime: "image/png" | "image/jpeg" | "image/webp" }[];
  costNanocents: number;
};

export type SegmentRequest = AiCallOptions & {
  image: { mime: AiImageMime; bytes: Uint8Array };
  // A short noun phrase ("receipt", "paper document"): letters and single spaces, at most 40.
  prompt: string;
  // Default "lossless".
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
};

export type SegmentMatch = {
  // Source pixels, not normalized.
  box: { x1: number; y1: number; x2: number; y2: number };
  confidence?: number;
  // Undecoded: the payload is base85, decoded by the caller that needs the mask. x and y place
  // the mask's top-left corner, as the answer gives them.
  mask: {
    x: number;
    y: number;
    height: number;
    width: number;
    encoding: "lossless" | "one_bit";
    payload: string;
  } | null;
};

export type SegmentResult = {
  callId: string;
  // From the answer; null when nothing matched (the answer then carries no size).
  imageWidth: number | null;
  imageHeight: number | null;
  matches: SegmentMatch[];
  costNanocents: number;
};

// Why a call that reached the provider did not answer. These are the only values the ledger's
// failure column accepts.
export type AiFailureCategory =
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "bad_request"
  | "auth"
  | "billing"
  | "too_long"
  | "network"
  | "unknown";

export type AiErrorCategory =
  | "disabled"
  | "not_configured"
  | "cap"
  | "too_expensive"
  | AiFailureCategory;

// A category and, when the provider answered, its HTTP status. Never the upstream message.
export class AiError extends Error {
  readonly category: AiErrorCategory;
  readonly httpStatus?: number;

  constructor(category: AiErrorCategory, httpStatus?: number) {
    super(httpStatus ? `model call: ${category} (${httpStatus})` : `model call: ${category}`);
    this.name = "AiError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

// What the provider reported that the price is computed from.
export type Metered =
  | { unit: "tokens"; usage: AiUsage }
  | { unit: "audio_seconds"; seconds: number }
  | { unit: "images"; count: number };

export type TextAnswer = {
  text: string;
  toolCalls: AiToolCall[];
  replay: AiReplayItem[];
  toolSearches: number;
};

// What one HTTP call produced, before it is settled in the ledger.
// answered: the provider reported what the price needs, so the cost is known.
// refused: a definite refusal that is never charged; the reservation is released.
// unknown: a timeout, a network error, a 5xx or an unreadable answer; the reservation stays
// counted, because whether the provider charged is not known.
export type CallOutcome<T = TextAnswer> =
  | {
      kind: "answered";
      status: "ok" | "incomplete";
      httpStatus: number;
      upstreamId: string | null;
      metered: Metered;
      value: T;
    }
  | { kind: "refused"; category: AiFailureCategory; httpStatus: number }
  | { kind: "unknown"; category: AiFailureCategory; httpStatus: number | null };
