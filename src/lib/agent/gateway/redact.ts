import { isLocalDate } from "../../time/local-date";
import { isUuid } from "../../uuid";

// What the decision log keeps of a tool call's args: ids, whole numbers, dates, booleans and the
// enum values the registry's schemas declare. Every other string becomes its length, so free text
// a model writes (and any personal data in it) never reaches the log.

export type RedactedString = { len: number };

const MAX_DEPTH = 6;

export function redactValue(value: unknown, enums: ReadonlySet<string>, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const len = value.length;
    if (isUuid(value) || isLocalDate(value) || enums.has(value)) return value;
    return { len } satisfies RedactedString;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, enums, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(v, enums, depth + 1);
    }
    return out;
  }
  return null;
}

// Args are parsed by a strict schema before they are redacted, so every key is a schema key.
export function redactArgs(args: unknown, enums: ReadonlySet<string>): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return {};
  return redactValue(args, enums) as Record<string, unknown>;
}

// Every enum and const value a JSON schema declares, at any depth.
export function enumValuesOf(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) enumValuesOf(s, into);
  } else if (schema !== null && typeof schema === "object") {
    const node = schema as Record<string, unknown>;
    if (Array.isArray(node.enum)) {
      for (const v of node.enum) if (typeof v === "string") into.add(v);
    }
    if (typeof node.const === "string") into.add(node.const);
    for (const [key, v] of Object.entries(node)) {
      if (key !== "enum" && key !== "const") enumValuesOf(v, into);
    }
  }
  return into;
}
