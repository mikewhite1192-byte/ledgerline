import { createHash, randomUUID } from "node:crypto";

// The model replay the local demo-path run answers from. Pure: the fake host does the I/O.
//
// A request is matched by a fingerprint of what decides the answer in a fixed script: the path,
// the model id, the sorted tool names, how many tool results it carries, and either the last user
// text or, for a structured-output request, the output format's name. The auditor's user text is
// the evidence itself, which carries fresh ids and times every run, so a format request is matched
// by its format instead. Everything else (instructions, dates, earlier tool results) is left out,
// so a fresh seed at the same anchor replays the same script.

export const RESPONSES_PATH = "/v1/responses";
export const CHAT_PATH = "/v1/chat/completions";
export const MODEL_PATHS = [RESPONSES_PATH, CHAT_PATH] as const;
export type ModelPath = (typeof MODEL_PATHS)[number];

export type FingerprintParts = {
  path: ModelPath;
  model: string;
  tools: string[];
  toolResults: number;
  // The last user text, or "" for a structured-output request.
  user: string;
  format: string;
};

export type ReplayEntry = {
  label: string;
  path: ModelPath;
  // The upstream's answer as recorded, reasoning items and ids removed.
  body: Record<string, unknown>;
};

export type ReplayFixture = {
  version: 1;
  recordedOn: string;
  entries: Record<string, ReplayEntry>;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isModelPath(path: string): path is ModelPath {
  return (MODEL_PATHS as readonly string[]).includes(path);
}

// The text of one message's content: a plain string, or the text parts of a part list in order.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content)
    .map((part) => {
      const p = record(part);
      return p && (p.type === "input_text" || p.type === "text") ? str(p.text) : "";
    })
    .filter((t) => t !== "")
    .join("\n");
}

export function fingerprintParts(path: ModelPath, body: unknown): FingerprintParts {
  const b = record(body) ?? {};
  const model = str(b.model);
  if (path === RESPONSES_PATH) {
    const input = list(b.input).map(record);
    const tools = list(b.tools)
      .map(record)
      .map((t) => (t?.type === "function" ? str(t.name) : str(t?.type)))
      .filter((n) => n !== "")
      .sort();
    const toolResults = input.filter((i) => i?.type === "function_call_output").length;
    const users = input.filter((i) => i?.type === "message" && i.role === "user");
    const format = str(record(record(b.text)?.format)?.name);
    const user = format ? "" : textOf(users.at(-1)?.content);
    return { path, model, tools, toolResults, user, format };
  }
  const messages = list(b.messages).map(record);
  const tools = list(b.tools)
    .map((t) => str(record(record(t)?.function)?.name))
    .filter((n) => n !== "")
    .sort();
  const toolResults = messages.filter((m) => m?.role === "tool").length;
  const users = messages.filter((m) => m?.role === "user");
  const format = str(record(record(b.response_format)?.json_schema)?.name);
  const user = format ? "" : textOf(users.at(-1)?.content);
  return { path, model, tools, toolResults, user, format };
}

export function fingerprint(parts: FingerprintParts): string {
  const canonical = JSON.stringify([
    parts.path,
    parts.model,
    parts.tools,
    parts.toolResults,
    parts.user,
    parts.format,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// One readable line per fingerprint, for the fixture and for a miss: what to re-record.
export function labelOf(parts: FingerprintParts): string {
  const asked = parts.format ? `format ${parts.format}` : `user "${clip(parts.user, 72)}"`;
  return `${parts.model} ${parts.path} tools=${parts.tools.length} results=${parts.toolResults} ${asked}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

// What the fixture keeps of a recorded answer: the fields the app reads, without reasoning items
// (opaque, large, and never shown) and without upstream ids (stamped fresh on every replay).
export function stripForFixture(path: ModelPath, body: unknown): Json {
  const b = record(body) ?? {};
  if (path === RESPONSES_PATH) {
    const output = list(b.output)
      .map(record)
      .filter((item): item is Json => item !== null && item.type !== "reasoning")
      .map((item) => without(item, ["id", "call_id"]));
    return pick({ ...b, output }, ["object", "status", "model", "output", "usage", "incomplete_details"]);
  }
  const choices = list(b.choices).map((raw) => {
    const choice = record(raw);
    const message = record(choice?.message);
    if (!choice || !message || !Array.isArray(message.tool_calls)) return raw;
    const toolCalls = message.tool_calls.map((call) => {
      const c = record(call);
      return c ? without(c, ["id"]) : call;
    });
    return { ...choice, message: { ...message, tool_calls: toolCalls } };
  });
  return pick({ ...b, choices }, ["object", "model", "choices", "usage"]);
}

function pick(b: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((k) => k in b).map((k) => [k, b[k]]));
}

function without(b: Json, keys: string[]): Json {
  return Object.fromEntries(Object.entries(b).filter(([k]) => !keys.includes(k)));
}

// A recorded answer made fresh for this request: new response, item and tool-call ids, so no two
// replays share an upstream id, and every tool result the app sends back names a call it was given.
export function stampForReplay(path: ModelPath, body: Json): Json {
  const copy = structuredClone(body);
  if (path === RESPONSES_PATH) {
    copy.id = `resp_e2e_${randomUUID()}`;
    copy.output = list(copy.output).map((raw) => {
      const item = record(raw);
      if (!item) return raw;
      const fresh: Json = { id: `item_e2e_${randomUUID()}`, ...item };
      if (item.type === "function_call") fresh.call_id = `call_e2e_${randomUUID()}`;
      return fresh;
    });
    return copy;
  }
  copy.id = `chatcmpl_e2e_${randomUUID()}`;
  copy.choices = list(copy.choices).map((raw) => {
    const choice = record(raw);
    const message = record(choice?.message);
    if (!choice || !message) return raw;
    const toolCalls = list(message.tool_calls).map((call) => {
      const c = record(call);
      return c ? { ...c, id: `call_e2e_${randomUUID()}` } : call;
    });
    return { ...choice, message: { ...message, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) } };
  });
  return copy;
}

export function emptyFixture(recordedOn: string): ReplayFixture {
  return { version: 1, recordedOn, entries: {} };
}

// A fixture read from disk: the shape checked, anything else refused (a broken fixture must fail
// the run, never answer from half a file).
export function parseFixture(text: string): ReplayFixture {
  const parsed = record(JSON.parse(text));
  const entries = record(parsed?.entries);
  if (!parsed || parsed.version !== 1 || typeof parsed.recordedOn !== "string" || !entries) {
    throw new Error("the replay fixture is not a version 1 fixture");
  }
  for (const [key, raw] of Object.entries(entries)) {
    const e = record(raw);
    if (!/^[0-9a-f]{16}$/.test(key) || !e || typeof e.label !== "string" || !isModelPath(str(e.path)) || !record(e.body)) {
      throw new Error(`the replay fixture has a malformed entry ${key.slice(0, 16)}`);
    }
  }
  return parsed as ReplayFixture;
}

// Stable on disk and plain ASCII: entries sorted by fingerprint, two-space JSON, every character
// past ASCII written as its \u escape (the same data once parsed; a model's typography stays out
// of the house style checks), and a trailing newline.
export function serializeFixture(fixture: ReplayFixture): string {
  const entries = Object.fromEntries(Object.entries(fixture.entries).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify({ ...fixture, entries }, null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${text}\n`;
}
