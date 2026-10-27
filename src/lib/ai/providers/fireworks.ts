import type { CallOutcome } from "../types";
import { parseBaseten } from "./baseten";
import { asArray, asRecord } from "./http";

// Muse Spark Open's standby host: Fireworks' OpenAI-compatible Chat Completions
// (https://docs.fireworks.ai/api-reference/post-chatcompletions). The request body is Baseten's
// (./baseten.ts basetenBody): the same chat shape, text and tools only. Fireworks' US-only docs
// also name us.api.fireworks.ai; the first real call with a key confirms which host serves this
// model, and a wrong host fails closed (a connection error or a 404, never an answer).
export const FIREWORKS_CHAT_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
// Any opening or closing think tag, in any case, with or without attributes or its ">".
const THINK_TAG = /<\/?think\b/i;

// Some hosts return an open-weights model's reasoning inline, as one leading
// <think>...</think> block before the answer. Reasoning is not output, so that one block is
// removed. Anything else that looks like a think tag (a block that never closes, one inside
// another, a tag in the middle or after the answer, a tag in another case) is not a shape this
// parser knows, so the whole answer is null: unreadable, never guessed at.
export function withoutLeadingThink(content: string): string | null {
  const start = content.length - content.trimStart().length;
  if (!content.startsWith(THINK_OPEN, start)) return THINK_TAG.test(content) ? null : content;
  const end = content.indexOf(THINK_CLOSE, start + THINK_OPEN.length);
  if (end === -1) return null;
  const inner = content.slice(start + THINK_OPEN.length, end);
  const rest = content.slice(end + THINK_CLOSE.length);
  if (THINK_TAG.test(inner) || THINK_TAG.test(rest)) return null;
  return rest.trimStart();
}

// A 200 answer, in the OpenAI shape parseBaseten reads, with one leading think block removed
// from the text (never from tool calls). A separate reasoning field is ignored, as Baseten's
// parser ignores it. Text content that is not a string (a list of parts, say) or a think block
// this parser does not know is an unreadable answer: unknown, so its reservation stays counted
// and no other host is tried.
export function parseFireworks(json: unknown, httpStatus: number): CallOutcome {
  const message = asRecord(asRecord(asArray(asRecord(json)?.choices)[0])?.message);
  const content = message?.content;
  if (content !== undefined && content !== null && typeof content !== "string") {
    return { kind: "unknown", category: "unknown", httpStatus };
  }
  const outcome = parseBaseten(json, httpStatus);
  if (outcome.kind !== "answered") return outcome;
  const text = withoutLeadingThink(outcome.value.text);
  if (text === null) return { kind: "unknown", category: "unknown", httpStatus };
  return { ...outcome, value: { ...outcome.value, text } };
}
