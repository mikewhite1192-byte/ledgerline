import { z } from "zod";
import type { AiTool } from "../../ai";
import { isLocalDate } from "../../time/local-date";
import type { AnyToolDef, FieldError } from "./types";

// Argument parsing for every tool call: the model's JSON text against the tool's strict schema.
// A failure reports field paths and issue codes only, never the argument text itself.

export const MAX_ARGUMENTS_CHARS = 16_000;

// Shared field schemas. Ids are UUIDs, dates are real calendar dates in YYYY-MM-DD, cents are
// whole numbers.
export const idField = () => z.uuid();
export const dateField = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isLocalDate, { message: "not a calendar date" });

export type ParseResult<A> = { ok: true; args: A } | { ok: false; fieldErrors: FieldError[] };

function pathOf(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join(".") || "(root)";
}

export function parseArgs<A>(schema: z.ZodType<A>, argumentsJson: string): ParseResult<A> {
  if (typeof argumentsJson !== "string" || argumentsJson.length > MAX_ARGUMENTS_CHARS) {
    return { ok: false, fieldErrors: [{ path: "(root)", code: "too_long" }] };
  }
  let raw: unknown;
  try {
    // An empty argument string is an empty object: models send it for tools with no fields.
    raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
  } catch {
    return { ok: false, fieldErrors: [{ path: "(root)", code: "invalid_json" }] };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, args: parsed.data };
  const fieldErrors = parsed.error.issues.slice(0, 20).map((issue) => ({
    path: pathOf(issue.path),
    code: issue.code,
  }));
  return { ok: false, fieldErrors };
}

// JSON with object keys sorted at every level, so equal args give equal text (dedupe keys).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("value has no JSON form");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

// The JSON schema a model is offered for a tool, made from the same zod schema the gateway
// parses with. The $schema marker is dropped: providers take the bare object schema.
export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = json;
  void _drop;
  return rest;
}

export function aiToolOf(tool: AnyToolDef): AiTool {
  return { name: tool.name, description: tool.description, parameters: toolParameters(tool.args) };
}
