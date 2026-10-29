// The wrapper's shapes. Every runtime model call goes through ./index.ts (complete, transcribe,
// generateImage, segment); agent code sees these types and nothing provider-specific.

// Who serves a call. Fireworks is Muse Spark Open's standby host (./targets.ts FALLBACKS).
export type AiProvider = "meta" | "baseten" | "fireworks";

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
// A video is an H.264 or H.265 MP4 whose frame count the caller read from its header; the
// wrapper reads the header again and refuses a count that differs.
export type AiAttachment =
  | { kind: "image"; mime: AiImageMime; bytes: Uint8Array }
  | { kind: "pdf"; bytes: Uint8Array; filename?: string }
  | { kind: "video"; mime: "video/mp4"; bytes: Uint8Array; frameCount: number };

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
  // The model's own short summary of its reasoning, when its reasoning items carried one in
  // plain text. Model text: the caller masks figures before keeping it. Never logged.
  reasoningSummary?: string;
};

// --- Computer use (a Meta model driving a browser, https://dev.meta.ai/docs/computer-use) ---

// The five mouse buttons the docs name for a click.
export type ComputerButton = "left" | "right" | "wheel" | "back" | "forward";

export type ComputerPoint = { x: number; y: number };

// The nine documented action types, in pixels of the last screenshot sent. The wrapper never
// reads these: a call's actions come back raw (ComputerCall.actions) and the caller's validator
// turns them into this type or refuses the whole batch, so an unknown type is never dropped.
export type ComputerAction =
  | { type: "click"; x: number; y: number; button: ComputerButton }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: ComputerPoint[] }
  | { type: "keypress"; keys: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scrollX: number; scrollY: number }
  | { type: "type"; text: string }
  | { type: "screenshot" }
  | { type: "wait" };

// A check the platform raised on a step. Nothing in that step runs until a person decides.
export type SafetyCheck = { id: string; code: string; message: string };

// One computer_call item. raw is the whole item as received, sent back verbatim on the next
// call; checks holds the raw check objects as received, which are the only thing ever sent
// back as acknowledged, and only after a person approved each one.
export type ComputerCall = {
  callId: string;
  actions: Record<string, unknown>[];
  pendingSafetyChecks: SafetyCheck[];
  checks: Record<string, unknown>[];
  status: string | null;
  raw: Record<string, unknown>;
};

export type ComputerScreenshot = { mime: "image/png" | "image/jpeg"; bytes: Uint8Array };

// A call already made and the screenshot this app answered it with.
export type ComputerPair = {
  call: Record<string, unknown>;
  output: { callId: string; screenshot: ComputerScreenshot; acknowledged: Record<string, unknown>[] };
};

// One step of a computer-use loop. screenshot is the first screen, sent with the task; history
// is every call since and its answer, the last pair being the screen the model sees now.
export type ComputerRequest = AiCallOptions & {
  instructions: string;
  task: string;
  screenshot: ComputerScreenshot;
  history: ComputerPair[];
  // 16 to 8192. Default 1024.
  maxOutputTokens?: number;
  // Default "medium".
  reasoningEffort?: AiReasoningEffort;
};

// call is null when the model answered in text instead of asking for an action.
export type ComputerResult = AiResult & { call: ComputerCall | null };

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

// SAM 3.1 tracking one concept through a video. Frames are numbered from 0, as the answer's
// frame markers number them.
export type SegmentVideoRequest = AiCallOptions & {
  video: { mime: "video/mp4"; bytes: Uint8Array; frameCount: number };
  // One concept a request ("face", "license plate"), the same rule as SegmentRequest.prompt.
  prompt: string;
  // Default "both".
  propagation?: "both" | "forward" | "backward";
  // Default "one_bit": a redaction needs boxes, not exact masks.
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
};

export type SegmentVideoResult = {
  callId: string;
  // Only frames with at least one match; a frame missing from the map matched nothing.
  frames: ReadonlyMap<number, SegmentMatch[]>;
  // From the answer; null when nothing matched in any frame.
  width: number | null;
  height: number | null;
  // As the provider reported it (billed at least 50).
  framesProcessed: number;
  costNanocents: number;
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
  // The call's job (one trace, or one purpose with no trace) is over its hourly allowance, or
  // was stopped earlier and no admin has cleared it yet (src/lib/ai/watch.ts).
  | "job_cap"
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
  | { unit: "images"; count: number }
  | { unit: "video_frames"; count: number };

export type TextAnswer = {
  text: string;
  toolCalls: AiToolCall[];
  replay: AiReplayItem[];
  toolSearches: number;
  // Plain summary text from the answer's reasoning items, when any came back.
  reasoningSummary?: string;
  // Set only when the request offered the computer tool and the model asked for an action.
  computerCall?: ComputerCall;
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
