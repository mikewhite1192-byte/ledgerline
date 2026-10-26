import type { AiRequest, AiToolCall, CallOutcome } from "../types";
import { asArray, asRecord, upstreamIdFrom, usageFrom } from "./http";

// Muse Spark Open through Baseten's OpenAI-compatible Chat Completions
// (https://docs.baseten.co/development/model-apis/overview). Dark until Baseten credits land:
// the model slug, the usage field names and tool calling here are unverified against the network.
export const BASETEN_CHAT_URL = "https://inference.baseten.co/v1/chat/completions";

export type BasetenOptions = { maxOutputTokens: number };

export function basetenBody(model: string, request: AiRequest, options: BasetenOptions) {
  const messages = request.messages.map((m) => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsJson },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
  const tools = request.tools ?? [];
  return {
    model,
    messages,
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    // No reasoning parameter on this endpoint.
    max_tokens: options.maxOutputTokens,
    stream: false,
  };
}

// A 200 answer, in the OpenAI shape. finish_reason "length" means the output budget ran out.
export function parseBaseten(json: unknown, httpStatus: number): CallOutcome {
  const body = asRecord(json);
  const usageBody = asRecord(body?.usage);
  const usage = usageFrom(
    usageBody?.prompt_tokens,
    asRecord(usageBody?.prompt_tokens_details)?.cached_tokens,
    usageBody?.completion_tokens,
    asRecord(usageBody?.completion_tokens_details)?.reasoning_tokens,
  );
  const choice = asRecord(asArray(body?.choices)[0]);
  const message = asRecord(choice?.message);
  if (!body || !usage || !choice || !message) {
    return { kind: "unknown", category: "unknown", httpStatus };
  }

  const toolCalls: AiToolCall[] = [];
  for (const raw of asArray(message.tool_calls)) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (
      typeof call?.id === "string" &&
      typeof fn?.name === "string" &&
      typeof fn.arguments === "string"
    ) {
      toolCalls.push({ id: call.id, name: fn.name, argumentsJson: fn.arguments });
    }
  }
  return {
    kind: "answered",
    status: choice.finish_reason === "length" ? "incomplete" : "ok",
    httpStatus,
    upstreamId: upstreamIdFrom(body.id),
    usage,
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    replay: [],
  };
}
