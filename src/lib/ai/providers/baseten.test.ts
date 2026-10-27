import { describe, expect, it } from "vitest";
import { basetenBody, parseBaseten } from "./baseten";

const MODEL = "meta-models/muse-spark-open-1026";
const USAGE = {
  prompt_tokens: 20,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens: 30,
  completion_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 50,
};

describe("basetenBody", () => {
  it("sends Chat Completions messages, nested tools and max_tokens, with no reasoning parameter", () => {
    const body = basetenBody(
      MODEL,
      {
        purpose: "triage",
        messages: [
          { role: "system", content: "Classify the email." },
          { role: "user", content: "Invoice attached." },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "classify", argumentsJson: '{"kind":"invoice"}' }],
          },
          { role: "tool", toolCallId: "call_1", content: "ok" },
        ],
        tools: [
          { name: "classify", description: "Record the kind", parameters: { type: "object" } },
        ],
      },
      { maxOutputTokens: 512 },
    );
    expect(body).toEqual({
      model: MODEL,
      messages: [
        { role: "system", content: "Classify the email." },
        { role: "user", content: "Invoice attached." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "classify", arguments: '{"kind":"invoice"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "classify",
            description: "Record the kind",
            parameters: { type: "object" },
          },
        },
      ],
      max_tokens: 512,
      stream: false,
    });
  });

  it("leaves out tools when there are none", () => {
    const body = basetenBody(
      MODEL,
      { purpose: "triage", messages: [{ role: "user", content: "Hi" }] },
      {
        maxOutputTokens: 64,
      },
    );
    expect(body).not.toHaveProperty("tools");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });
});

describe("parseBaseten", () => {
  it("reads the first choice's text, tool calls and OpenAI usage", () => {
    const outcome = parseBaseten(
      {
        id: "chatcmpl-1",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Classifying.",
              tool_calls: [
                { id: "call_2", type: "function", function: { name: "classify", arguments: "{}" } },
                { id: "call_bad", type: "function", function: { name: "x" } },
              ],
            },
          },
        ],
        usage: USAGE,
      },
      200,
    );
    expect(outcome).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: "chatcmpl-1",
      metered: { unit: "tokens", usage: { input: 20, cached: 4, output: 30, reasoning: 10 } },
      value: {
        text: "Classifying.",
        toolCalls: [{ id: "call_2", name: "classify", argumentsJson: "{}" }],
        replay: [],
        toolSearches: 0,
      },
    });
  });

  it("reads finish_reason length as incomplete", () => {
    const outcome = parseBaseten(
      { id: "c", choices: [{ finish_reason: "length", message: { content: null } }], usage: USAGE },
      200,
    );
    // The measured 64-token answer: content null, reasoning only.
    expect(outcome).toMatchObject({
      kind: "answered",
      status: "incomplete",
      value: { text: "", toolCalls: [] },
    });
  });

  it("treats an answer without a choice or usable usage as unknown", () => {
    for (const json of [
      null,
      { choices: [], usage: USAGE },
      { choices: [{ message: { content: "x" } }] },
      { choices: [{ message: { content: "x" } }], usage: { ...USAGE, completion_tokens: "30" } },
      { choices: [{ finish_reason: "stop" }], usage: USAGE },
    ]) {
      expect(parseBaseten(json, 200), JSON.stringify(json)).toEqual({
        kind: "unknown",
        category: "unknown",
        httpStatus: 200,
      });
    }
  });
});
