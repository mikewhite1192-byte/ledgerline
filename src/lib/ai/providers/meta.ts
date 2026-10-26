import type { AiReasoningEffort, AiReplayItem, AiRequest, AiToolCall, CallOutcome } from "../types";
import { asArray, asRecord, upstreamIdFrom, usageFrom } from "./http";

// Muse Spark through the Meta Model API's Responses endpoint
// (https://dev.meta.ai/docs/protocols/responses). Stateless: store is false, so this app's
// conversation is the only copy, and the model's reasoning comes back encrypted for the next turn.
export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

export type MetaOptions = { maxOutputTokens: number; reasoningEffort: AiReasoningEffort };

const text = (type: "input_text" | "output_text", value: string) => [{ type, text: value }];

export function metaBody(model: string, request: AiRequest, options: MetaOptions) {
  const instructions = request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  // Replayed reasoning goes just before the assistant turn it produced, the order the model
  // returned them in.
  const lastAssistant = request.messages.findLastIndex((m) => m.role === "assistant");
  const input: unknown[] = [];
  request.messages.forEach((m, i) => {
    if (i === lastAssistant) input.push(...(request.replay ?? []));
    switch (m.role) {
      case "system":
        return;
      case "user":
        input.push({ type: "message", role: "user", content: text("input_text", m.content) });
        return;
      case "assistant":
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: text("output_text", m.content),
          });
        }
        for (const call of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.argumentsJson,
          });
        }
        return;
      case "tool":
        input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        return;
    }
  });
  const tools = request.tools ?? [];
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          // The only value Meta accepts.
          tool_choice: "auto",
        }
      : {}),
    // Reasoning and visible text together: a small cap can be spent entirely on reasoning.
    max_output_tokens: options.maxOutputTokens,
    reasoning: { effort: options.reasoningEffort },
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

// A 200 answer. Usage decides the cost, so an answer without usable usage, or with a status other
// than completed or incomplete, is settled as unknown with its reservation kept.
export function parseMeta(json: unknown, httpStatus: number): CallOutcome {
  const body = asRecord(json);
  const usageBody = asRecord(body?.usage);
  const usage = usageFrom(
    usageBody?.input_tokens,
    asRecord(usageBody?.input_tokens_details)?.cached_tokens,
    usageBody?.output_tokens,
    asRecord(usageBody?.output_tokens_details)?.reasoning_tokens,
  );
  const status =
    body?.status === "completed" ? "ok" : body?.status === "incomplete" ? "incomplete" : null;
  if (!body || !usage || !status) return { kind: "unknown", category: "unknown", httpStatus };

  const parts: string[] = [];
  const toolCalls: AiToolCall[] = [];
  const replay: AiReplayItem[] = [];
  for (const raw of asArray(body.output)) {
    const item = asRecord(raw);
    if (item?.type === "message") {
      for (const part of asArray(item.content)) {
        const p = asRecord(part);
        if (p?.type === "output_text" && typeof p.text === "string") parts.push(p.text);
      }
    } else if (item?.type === "function_call") {
      const { call_id: id, name, arguments: args } = item;
      if (typeof id === "string" && typeof name === "string" && typeof args === "string") {
        toolCalls.push({ id, name, argumentsJson: args });
      }
    } else if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
      // Sent back without its id: nothing is stored upstream (store: false), and Meta requires
      // a summary field on every reasoning input item.
      replay.push({
        type: "reasoning",
        summary: Array.isArray(item.summary) ? item.summary : [],
        encrypted_content: item.encrypted_content,
      });
    }
  }
  return {
    kind: "answered",
    status,
    httpStatus,
    upstreamId: upstreamIdFrom(body.id),
    usage,
    text: parts.join(""),
    toolCalls,
    replay,
  };
}
