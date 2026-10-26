import { describe, expect, it } from "vitest";
import type { AiReplayItem, AiRequest } from "../types";
import { metaBody, parseMeta } from "./meta";

const OPTIONS = { maxOutputTokens: 1024, reasoningEffort: "low" as const };
const USAGE = {
  input_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 64,
  output_tokens_details: { reasoning_tokens: 62 },
  total_tokens: 79,
};

describe("metaBody", () => {
  it("sends a stateless Responses request with the system text as instructions", () => {
    const body = metaBody(
      "muse-spark-1.3",
      {
        purpose: "proof",
        messages: [
          { role: "system", content: "Reply in one sentence." },
          { role: "user", content: "Say hello to the money desk." },
        ],
      },
      OPTIONS,
    );
    expect(body).toEqual({
      model: "muse-spark-1.3",
      instructions: "Reply in one sentence.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello to the money desk." }],
        },
      ],
      max_output_tokens: 1024,
      reasoning: { effort: "low" },
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("sends tools, tool calls, tool results and replayed reasoning in the order they happened", () => {
    const replay: AiReplayItem[] = [{ type: "reasoning", summary: [], encrypted_content: "enc-1" }];
    const request: AiRequest = {
      purpose: "agent_turn",
      messages: [
        { role: "system", content: "You help a payroll desk." },
        { role: "user", content: "What does Ana earn this week?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "pay.read", argumentsJson: '{"driver":"ana"}' }],
        },
        { role: "tool", toolCallId: "call_1", content: '{"cents":123400}' },
      ],
      tools: [
        {
          name: "pay.read",
          description: "Read a driver's pay",
          parameters: { type: "object", properties: { driver: { type: "string" } } },
        },
      ],
      replay,
    };
    const body = metaBody("muse-spark-1.3", request, { ...OPTIONS, reasoningEffort: "minimal" });
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What does Ana earn this week?" }],
      },
      { type: "reasoning", summary: [], encrypted_content: "enc-1" },
      { type: "function_call", call_id: "call_1", name: "pay.read", arguments: '{"driver":"ana"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"cents":123400}' },
    ]);
    expect(body).toMatchObject({
      instructions: "You help a payroll desk.",
      tools: [
        {
          type: "function",
          name: "pay.read",
          description: "Read a driver's pay",
          parameters: { type: "object", properties: { driver: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "minimal" },
      store: false,
    });
  });

  it("sends assistant text as output_text and leaves out empty instructions", () => {
    const body = metaBody(
      "muse-spark-1.3",
      {
        purpose: "chat",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello." },
          { role: "user", content: "Again" },
        ],
      },
      OPTIONS,
    );
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.input[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello." }],
    });
  });
});

describe("parseMeta", () => {
  it("reads text, tool calls, encrypted reasoning and usage from a completed answer", () => {
    const outcome = parseMeta(
      {
        id: "resp_abc123",
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "thinking" }],
            encrypted_content: "enc-xyz",
          },
          { type: "reasoning", id: "rs_2", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Hello, ", annotations: [] },
              { type: "refusal", refusal: "no" },
              { type: "output_text", text: "money desk.", annotations: [] },
            ],
          },
          {
            type: "function_call",
            call_id: "call_9",
            name: "pay.read",
            arguments: "{}",
            status: "completed",
          },
          { type: "function_call", call_id: "call_bad", name: 7, arguments: "{}" },
        ],
        usage: { ...USAGE, input_tokens_details: { cached_tokens: 5 } },
      },
      200,
    );
    expect(outcome).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: "resp_abc123",
      usage: { input: 15, cached: 5, output: 64, reasoning: 62 },
      text: "Hello, money desk.",
      toolCalls: [{ id: "call_9", name: "pay.read", argumentsJson: "{}" }],
      // Without the server id (nothing is stored upstream), with its summary.
      replay: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
          encrypted_content: "enc-xyz",
        },
      ],
    });
  });

  it("settles the measured out-of-budget answer as incomplete, charged from usage", () => {
    // The shape a 64-token cap returned on 2026-10-26: reasoning used 62 tokens, no message.
    const outcome = parseMeta(
      {
        id: "resp_measured",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", id: "rs_1", summary: [] }],
        usage: USAGE,
      },
      200,
    );
    expect(outcome).toMatchObject({
      kind: "answered",
      status: "incomplete",
      text: "",
      toolCalls: [],
      replay: [],
      usage: { input: 15, cached: 0, output: 64, reasoning: 62 },
    });
  });

  it("treats an answer without usable usage or a final status as unknown", () => {
    const bad: unknown[] = [
      null,
      "text",
      [],
      { status: "completed", output: [] },
      { status: "completed", usage: { ...USAGE, output_tokens: -1 } },
      { status: "completed", usage: { ...USAGE, input_tokens_details: { cached_tokens: 99 } } },
      { status: "failed", usage: USAGE },
      { status: "in_progress", usage: USAGE },
      { status: "cancelled", usage: USAGE },
      { usage: USAGE },
    ];
    for (const json of bad) {
      expect(parseMeta(json, 200), JSON.stringify(json)).toEqual({
        kind: "unknown",
        category: "unknown",
        httpStatus: 200,
      });
    }
  });

  it("drops an id that is not a plain token", () => {
    const outcome = parseMeta({ id: "resp 1\nforged", status: "completed", usage: USAGE }, 200);
    expect(outcome).toMatchObject({ kind: "answered", upstreamId: null, text: "" });
  });
});
