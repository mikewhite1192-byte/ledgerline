import type {
  AiAttachment,
  AiReasoningEffort,
  AiReplayItem,
  AiRequest,
  AiToolCall,
  CallOutcome,
} from "../types";
import { asArray, asRecord, upstreamIdFrom, usageFrom } from "./http";
import { dataUrl } from "./media";

// Muse Spark and Muse Wonder through the Meta Model API's Responses endpoint
// (https://dev.meta.ai/docs/protocols/responses). Stateless: store is false, so this app's
// conversation is the only copy, and the model's reasoning comes back encrypted for the next turn.
export const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";

export type MetaOptions = { maxOutputTokens: number; reasoningEffort: AiReasoningEffort };

// Whether a hosted tool search's call and output items are sent back with the next request of
// the same loop, like the reasoning items. The parser keeps them either way; this decides
// whether the body carries them. Measured against the live API before it was set: see the
// probe notes in the pull request.
export const ECHO_TOOL_SEARCH_ITEMS = true;

const isToolSearchItem = (item: AiReplayItem) =>
  item.type === "tool_search_call" || item.type === "tool_search_output";

const text = (type: "input_text" | "output_text", value: string) => ({ type, text: value });

// An image as a base64 data URL; a PDF as inline file data, never a file id, so nothing of a
// carrier's documents is kept upstream (https://dev.meta.ai/docs/image-understanding,
// https://dev.meta.ai/docs/file-handling).
function attachmentPart(a: AiAttachment) {
  return a.kind === "image"
    ? { type: "input_image", image_url: dataUrl(a.mime, a.bytes) }
    : {
        type: "input_file",
        file_data: dataUrl("application/pdf", a.bytes),
        ...(a.filename ? { filename: a.filename } : {}),
      };
}

export function metaBody(model: string, request: AiRequest, options: MetaOptions) {
  // System messages join into instructions unless placed in input, where they keep their
  // position (a system-role input item stands as an instruction all the same).
  const instructions = request.messages
    .filter((m) => m.role === "system" && m.placement !== "input")
    .map((m) => m.content)
    .join("\n\n");
  // Replayed items go just before the assistant turn they produced, the order the model
  // returned them in. The last answer's full list (request.replay) stands in for that turn's own
  // items; every earlier turn keeps its tool search items, so a tool it loaded stays loaded.
  const lastAssistant = request.messages.findLastIndex((m) => m.role === "assistant");
  const echo = (items: readonly AiReplayItem[]) =>
    items.filter((item) => ECHO_TOOL_SEARCH_ITEMS || !isToolSearchItem(item));
  const replay = echo(request.replay ?? []);
  const input: unknown[] = [];
  request.messages.forEach((m, i) => {
    if (m.role === "assistant") {
      input.push(...(i === lastAssistant && replay.length > 0 ? replay : echo(m.replay ?? [])));
    }
    switch (m.role) {
      case "system":
        if (m.placement === "input") {
          input.push({ type: "message", role: "system", content: [text("input_text", m.content)] });
        }
        return;
      case "user": {
        const attachments = m.attachments ?? [];
        // The text first, then what it refers to; an empty text is left out only when the turn
        // carries attachments.
        const content = [
          ...(m.content || attachments.length === 0 ? [text("input_text", m.content)] : []),
          ...attachments.map(attachmentPart),
        ];
        input.push({ type: "message", role: "user", content });
        return;
      }
      case "assistant":
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [text("output_text", m.content)],
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
  const format = request.format;
  const cache = request.cache;
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    ...(tools.length > 0
      ? {
          tools: [
            // Hosted search (https://dev.meta.ai/docs/tool-search): the model searches the
            // deferred tools inside the same response and the API loads the schema it picks.
            ...(request.toolSearch ? [{ type: "tool_search" }] : []),
            ...tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              ...(t.deferLoading ? { defer_loading: true } : {}),
            })),
          ],
          // The only value Meta accepts.
          tool_choice: "auto",
        }
      : {}),
    // Structured output on Responses is text.format, not response_format
    // (https://dev.meta.ai/docs/structured-output).
    ...(format
      ? {
          text: {
            format: {
              type: "json_schema",
              name: format.name,
              schema: format.schema,
              ...(format.strict !== undefined ? { strict: format.strict } : {}),
            },
          },
        }
      : {}),
    // Reasoning and visible text together: a small cap can be spent entirely on reasoning.
    max_output_tokens: options.maxOutputTokens,
    reasoning: { effort: options.reasoningEffort },
    store: false,
    include: ["reasoning.encrypted_content"],
    // Automatic prefix caching (https://dev.meta.ai/docs/prompt-caching). in_memory is the
    // default retention, so only 24h is sent.
    ...(cache
      ? {
          prompt_cache_key: cache.key,
          ...(cache.retention === "24h" ? { prompt_cache_retention: "24h" } : {}),
        }
      : {}),
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
  let toolSearches = 0;
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
    } else if (item?.type === "tool_search_call" || item?.type === "tool_search_output") {
      // A hosted search and the tools it loaded, kept whole for the next request of the loop
      // except the id (nothing is stored upstream). Counted, never read, never logged.
      const type = item.type;
      if (type === "tool_search_call") toolSearches += 1;
      const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"));
      replay.push({ ...rest, type });
    }
  }
  return {
    kind: "answered",
    status,
    httpStatus,
    upstreamId: upstreamIdFrom(body.id),
    metered: { unit: "tokens", usage },
    value: { text: parts.join(""), toolCalls, replay, toolSearches },
  };
}
