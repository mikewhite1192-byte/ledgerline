// The wrapper's shapes. Every runtime model call goes through complete() in ./index.ts; agent
// code sees these types and nothing provider-specific.

export type AiProvider = "meta" | "baseten";

export type AiReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type AiToolCall = { id: string; name: string; argumentsJson: string };

export type AiMessage =
  | { role: "system" | "user"; content: string }
  // An assistant turn: its text and the tool calls it made, if any.
  | { role: "assistant"; content: string; toolCalls?: AiToolCall[] }
  // The result of one tool call, matched to it by id.
  | { role: "tool"; content: string; toolCallId: string };

// parameters is a JSON Schema object.
export type AiTool = { name: string; description: string; parameters: Record<string, unknown> };

// Opaque provider items from the previous turn (Meta's encrypted reasoning), sent back unchanged
// so the model keeps its reasoning across a tool loop. Never stored, never logged.
export type AiReplayItem = { readonly type: "reasoning" } & Record<string, unknown>;

export type AiRequest = {
  // What the call is for, recorded in the ledger: lower case, digits and underscores, 3 to 40.
  purpose: string;
  messages: AiMessage[];
  tools?: AiTool[];
  // Reasoning and visible text together. Default 1024, 16 to 8192.
  maxOutputTokens?: number;
  // Meta only. Default "low".
  reasoningEffort?: AiReasoningEffort;
  // The call is refused if its worst-case cost is above this. Default 25.
  maxCostCents?: number;
  // Default 25,000.
  timeoutMs?: number;
  replay?: AiReplayItem[];
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

// What one HTTP call produced, before it is settled in the ledger.
// answered: the provider reported usage, so the cost is known.
// refused: a definite refusal that is never charged; the reservation is released.
// unknown: a timeout, a network error, a 5xx or an unreadable answer; the reservation stays
// counted, because whether the provider charged is not known.
export type CallOutcome =
  | {
      kind: "answered";
      status: "ok" | "incomplete";
      httpStatus: number;
      upstreamId: string | null;
      usage: AiUsage;
      text: string;
      toolCalls: AiToolCall[];
      replay: AiReplayItem[];
    }
  | { kind: "refused"; category: AiFailureCategory; httpStatus: number }
  | { kind: "unknown"; category: AiFailureCategory; httpStatus: number | null };
