import type {
  AiAttachment,
  AiCitation,
  AiReasoningEffort,
  AiReplayItem,
  AiRequest,
  AiSearchResult,
  AiToolCall,
  CallOutcome,
  ComputerCall,
  ComputerRequest,
  ComputerScreenshot,
  SafetyCheck,
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

// An image or a video as a base64 data URL; a PDF as inline file data, never a file id, so
// nothing of a carrier's documents is kept upstream (https://dev.meta.ai/docs/image-understanding,
// https://dev.meta.ai/docs/video-understanding, https://dev.meta.ai/docs/file-handling).
function attachmentPart(a: AiAttachment) {
  switch (a.kind) {
    case "image":
      return { type: "input_image", image_url: dataUrl(a.mime, a.bytes) };
    case "video":
      return { type: "input_video", video_url: dataUrl("video/mp4", a.bytes) };
    case "pdf":
      return {
        type: "input_file",
        file_data: dataUrl("application/pdf", a.bytes),
        ...(a.filename ? { filename: a.filename } : {}),
      };
  }
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
  // Hosted web search (https://dev.meta.ai/docs/search-grounding). The wrapper refuses it beside
  // function tools, so it is the request's only tool. max_tool_calls caps the searches the model
  // may run inside this one answer, and each search is billed.
  const webSearch = request.webSearch;
  const toolPart: {
    tools?: Record<string, unknown>[];
    tool_choice?: "auto";
    max_tool_calls?: number;
  } =
    tools.length > 0
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
      : webSearch
        ? {
            tools: [{ type: "web_search", search_context_size: webSearch.contextSize }],
            max_tool_calls: webSearch.maxCalls,
          }
        : {};
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    ...toolPart,
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
    // With web search, the pages each search returned come back too: a number is taken from an
    // answer only when it is found whole in a returned page the answer cites.
    include: webSearch
      ? ["reasoning.encrypted_content", "web_search_call.results"]
      : ["reasoning.encrypted_content"],
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

const screenshotUrl = (s: ComputerScreenshot) => dataUrl(s.mime, s.bytes);

// One step of a computer-use loop (https://dev.meta.ai/docs/computer-use). The task and the
// first screen open the conversation; then each call the model made, sent back verbatim, and
// this app's answer to it: the screen after its actions ran and the checks a person approved.
// Stateless like metaBody: nothing is kept upstream, so this app's rows are the only copy.
export function metaComputerBody(model: string, request: ComputerRequest, options: MetaOptions) {
  const input: unknown[] = [
    {
      type: "message",
      role: "user",
      content: [
        text("input_text", request.task),
        { type: "input_image", image_url: screenshotUrl(request.screenshot) },
      ],
    },
  ];
  // Only each computer_call goes back, not the reasoning items that came with it: they are not
  // stored, and the encrypted reasoning the request asks for is not replayed. The model works from
  // the task and the screens alone, which the local multi-step run showed is enough. A run is
  // bounded by its step, time and cost limits whatever the model does with less context.
  for (const pair of request.history) {
    input.push(pair.call, {
      type: "computer_call_output",
      call_id: pair.output.callId,
      acknowledged_safety_checks: pair.output.acknowledged,
      output: { type: "computer_screenshot", image_url: screenshotUrl(pair.output.screenshot) },
    });
  }
  return {
    model,
    instructions: request.instructions,
    input,
    tools: [{ type: "computer" }],
    max_output_tokens: options.maxOutputTokens,
    reasoning: { effort: options.reasoningEffort },
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

const CHECK_CODE = /^[a-z_]{2,60}$/;
const MAX_CHECK_MESSAGE = 500;
const MAX_UPSTREAM_ID = 200;

const upstreamString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_UPSTREAM_ID;

// A computer_call item, or null when it cannot be acted on safely: no call id, actions that are
// not a list of objects, or a safety check without an id (it could never be acknowledged, and a
// check that cannot be shown to a person must not be skipped). Actions stay raw; the caller's
// validator types them or refuses the batch.
function computerCallFrom(item: Record<string, unknown>): ComputerCall | null {
  if (!upstreamString(item.call_id) || !Array.isArray(item.actions)) return null;
  const actions: Record<string, unknown>[] = [];
  for (const a of item.actions) {
    const action = asRecord(a);
    if (!action) return null;
    actions.push(action);
  }
  const rawChecks = item.pending_safety_checks ?? [];
  if (!Array.isArray(rawChecks)) return null;
  const checks: Record<string, unknown>[] = [];
  const pendingSafetyChecks: SafetyCheck[] = [];
  for (const c of rawChecks) {
    const check = asRecord(c);
    if (!check || !upstreamString(check.id)) return null;
    checks.push(check);
    pendingSafetyChecks.push({
      id: check.id,
      code: typeof check.code === "string" && CHECK_CODE.test(check.code) ? check.code : "unknown",
      message: typeof check.message === "string" ? check.message.slice(0, MAX_CHECK_MESSAGE) : "",
    });
  }
  return {
    callId: item.call_id,
    actions,
    pendingSafetyChecks,
    checks,
    status: typeof item.status === "string" ? item.status : null,
    raw: item,
  };
}

// Bounds on what a web search answer may carry into this app: a page address the pinned_rates
// table can hold, a title the screen can show, and a snippet long enough to quote from. A field
// over its bound is dropped whole, never cut, so a kept address always equals the one the API sent.
const MAX_URL = 2000;
const MAX_TITLE = 500;
const MAX_SNIPPET = 4000;
const MAX_RESULTS = 50;
const MAX_CITATIONS = 50;

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const offset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// A url_citation annotation, with its span moved by `shift` (the length of the answer text before
// the part it came from), or null when any field is missing, out of bounds or the span is empty
// or falls outside the part.
function citationFrom(raw: unknown, shift: number, partLength: number): AiCitation | null {
  const a = asRecord(raw);
  if (a?.type !== "url_citation") return null;
  const { url, title, start_index: start, end_index: end } = a;
  if (!boundedString(url, MAX_URL) || !offset(start) || !offset(end)) return null;
  if (start >= end || end > partLength) return null;
  return {
    url,
    title: boundedString(title, MAX_TITLE) ? title : "",
    startIndex: start + shift,
    endIndex: end + shift,
  };
}

// The pages one web_search_call returned (present only when the request asked for
// web_search_call.results). An entry without a usable address is dropped. Measured on Muse Spark
// on Oct 27, 2026: every snippet came back "" and the answer's annotations came back empty, so a
// caller must not depend on either being there.
function searchResultsFrom(item: Record<string, unknown>): AiSearchResult[] {
  const results: AiSearchResult[] = [];
  for (const raw of asArray(item.results)) {
    const r = asRecord(raw);
    if (!r || !boundedString(r.url, MAX_URL)) continue;
    results.push({
      url: r.url,
      title: boundedString(r.title, MAX_TITLE) ? r.title : "",
      snippet: boundedString(r.snippet, MAX_SNIPPET) ? r.snippet : "",
    });
  }
  return results;
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
  const computerCalls: (ComputerCall | null)[] = [];
  const answerParts: string[] = [];
  const citations: AiCitation[] = [];
  const searchResults: AiSearchResult[] = [];
  let searchCalls = 0;
  // The length of the text so far, so each citation's span points into the joined text (`text`,
  // commentary included; `answerText` leaves the commentary out and carries no spans of its own).
  let textLength = 0;
  for (const raw of asArray(body.output)) {
    const item = asRecord(raw);
    if (item?.type === "message") {
      for (const part of asArray(item.content)) {
        const p = asRecord(part);
        if (p?.type === "output_text" && typeof p.text === "string") {
          for (const a of asArray(p.annotations)) {
            const citation = citationFrom(a, textLength, p.text.length);
            if (citation && citations.length < MAX_CITATIONS) citations.push(citation);
          }
          parts.push(p.text);
          if (item.phase !== "commentary") answerParts.push(p.text);
          textLength += p.text.length;
        }
      }
    } else if (item?.type === "web_search_call") {
      // Every search item is counted for the bill, whatever its status: billing more than ran
      // keeps the ledger at or above the provider's charge.
      searchCalls += 1;
      for (const r of searchResultsFrom(item)) {
        if (searchResults.length < MAX_RESULTS) searchResults.push(r);
      }
    } else if (item?.type === "function_call") {
      const { call_id: id, name, arguments: args } = item;
      if (typeof id === "string" && typeof name === "string" && typeof args === "string") {
        toolCalls.push({ id, name, argumentsJson: args });
      }
    } else if (item?.type === "computer_call") {
      computerCalls.push(computerCallFrom(item));
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
  // The docs promise one computer_call per turn. More than one, or one that cannot be acted on
  // safely, is not guessed at: the answer is unknown and nothing runs.
  if (computerCalls.length > 1 || computerCalls.includes(null)) {
    return { kind: "unknown", category: "unknown", httpStatus };
  }
  const computerCall = computerCalls[0];
  // Only an answer that searched or cited carries the web part and a search count to bill.
  const searched = searchCalls > 0 || citations.length > 0;
  return {
    kind: "answered",
    status,
    httpStatus,
    upstreamId: upstreamIdFrom(body.id),
    metered: searched ? { unit: "tokens", usage, searches: searchCalls } : { unit: "tokens", usage },
    value: {
      text: parts.join(""),
      toolCalls,
      replay,
      toolSearches,
      ...(searched
        ? { web: { answerText: answerParts.join(""), citations, searchResults, searchCalls } }
        : {}),
      ...(computerCall ? { computerCall } : {}),
    },
  };
}
