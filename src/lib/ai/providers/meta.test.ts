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

describe("metaBody structured output, attachments and effort", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PDF = new Uint8Array([...Buffer.from("%PDF-1.4")]);

  it("sends structured output as text.format with the caller's names, and max effort as is", () => {
    const schema = { type: "object", properties: { load: { type: "string" } }, required: ["load"] };
    const body = metaBody(
      "muse-wonder-1.0",
      {
        purpose: "audit",
        messages: [{ role: "user", content: "Check it." }],
        format: { name: "audit_finding", schema, strict: true },
      },
      { maxOutputTokens: 64, reasoningEffort: "max" },
    );
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "audit_finding", schema, strict: true },
    });
    expect(body).not.toHaveProperty("response_format");
    expect(body.reasoning).toEqual({ effort: "max" });
    // Without strict, no strict key.
    const loose = metaBody(
      "muse-spark-1.3",
      { purpose: "x", messages: [{ role: "user", content: "x" }], format: { name: "f", schema } },
      OPTIONS,
    );
    expect(loose.text).toEqual({ format: { type: "json_schema", name: "f", schema } });
  });

  it("sends images and PDFs inline after the turn's text, never as file ids", () => {
    const body = metaBody(
      "muse-spark-1.3",
      {
        purpose: "doc",
        messages: [
          {
            role: "user",
            content: "Read these.",
            attachments: [
              { kind: "image", mime: "image/png", bytes: PNG },
              { kind: "pdf", bytes: PDF, filename: "rate-con.pdf" },
              { kind: "pdf", bytes: PDF },
            ],
          },
        ],
      },
      OPTIONS,
    );
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Read these." },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
        },
        {
          type: "input_file",
          file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString("base64")}`,
          filename: "rate-con.pdf",
        },
        {
          type: "input_file",
          file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString("base64")}`,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("file_id");
  });

  it("leaves out an empty text part when a turn carries only attachments", () => {
    const body = metaBody(
      "muse-spark-1.3",
      {
        purpose: "doc",
        messages: [
          {
            role: "user",
            content: "",
            attachments: [{ kind: "image", mime: "image/png", bytes: PNG }],
          },
        ],
      },
      OPTIONS,
    );
    expect(body.input[0]).toMatchObject({ content: [{ type: "input_image" }] });
    expect((body.input[0] as { content: unknown[] }).content).toHaveLength(1);
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
      metered: { unit: "tokens", usage: { input: 15, cached: 5, output: 64, reasoning: 62 } },
      value: {
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
        toolSearches: 0,
      },
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
      metered: { unit: "tokens", usage: { input: 15, cached: 0, output: 64, reasoning: 62 } },
      value: { text: "", toolCalls: [], replay: [] },
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
    expect(outcome).toMatchObject({ kind: "answered", upstreamId: null, value: { text: "" } });
  });
});

// An operator-shaped request: the static prompt, the session summary, a tool round and replayed
// reasoning.
const OPERATOR_REQUEST: AiRequest = {
  purpose: "agent_operator_turn",
  messages: [
    { role: "system", content: "You answer for the payroll desk." },
    { role: "system", content: "Carrier: Demo Freight. Week: 2026-10-26 to 2026-11-01." },
    { role: "user", content: "What is driver D-01 owed this week?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "get_driver", argumentsJson: '{"driver_id":"d-01"}' }],
    },
    { role: "tool", toolCallId: "call_1", content: '{"cents":123400}' },
  ],
  tools: [
    {
      name: "get_driver",
      description: "Read one driver",
      parameters: {
        type: "object",
        properties: { driver_id: { type: "string" } },
        required: ["driver_id"],
        additionalProperties: false,
      },
    },
    {
      name: "propose_advance",
      description: "Propose an advance",
      parameters: {
        type: "object",
        properties: { cents: { type: "integer" } },
        required: ["cents"],
        additionalProperties: false,
      },
    },
  ],
  replay: [{ type: "reasoning", summary: [], encrypted_content: "enc-1" }],
};

// The exact bytes the wrapper sent for OPERATOR_REQUEST before tool search and the prompt cache
// existed, captured from the previous metaBody. With both off, the body must not change by a byte.
const BODY_BEFORE =
  '{"model":"muse-spark-1.3","instructions":"You answer for the payroll desk.\\n\\nCarrier: Demo Freight. Week: 2026-10-26 to 2026-11-01.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"What is driver D-01 owed this week?"}]},{"type":"reasoning","summary":[],"encrypted_content":"enc-1"},{"type":"function_call","call_id":"call_1","name":"get_driver","arguments":"{\\"driver_id\\":\\"d-01\\"}"},{"type":"function_call_output","call_id":"call_1","output":"{\\"cents\\":123400}"}],"tools":[{"type":"function","name":"get_driver","description":"Read one driver","parameters":{"type":"object","properties":{"driver_id":{"type":"string"}},"required":["driver_id"],"additionalProperties":false}},{"type":"function","name":"propose_advance","description":"Propose an advance","parameters":{"type":"object","properties":{"cents":{"type":"integer"}},"required":["cents"],"additionalProperties":false}}],"tool_choice":"auto","max_output_tokens":1200,"reasoning":{"effort":"low"},"store":false,"include":["reasoning.encrypted_content"]}';

const OPERATOR_OPTIONS = { maxOutputTokens: 1200, reasoningEffort: "low" as const };

// An auditor-shaped request: structured output on Muse Wonder, no tools. Its bytes, captured from
// the previous metaBody, must not change either.
const AUDIT_REQUEST: AiRequest = {
  purpose: "audit_proposal",
  messages: [
    { role: "system", content: "You check one proposal." },
    { role: "user", content: '{"proposal":{"amountCents":10000}}' },
  ],
  format: {
    name: "audit_verdict",
    strict: true,
    schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
  },
};

const AUDIT_BODY_BEFORE =
  '{"model":"muse-wonder-1.0","instructions":"You check one proposal.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"{\\"proposal\\":{\\"amountCents\\":10000}}"}]}],"text":{"format":{"type":"json_schema","name":"audit_verdict","schema":{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"],"additionalProperties":false},"strict":true}},"max_output_tokens":2400,"reasoning":{"effort":"high"},"store":false,"include":["reasoning.encrypted_content"]}';

describe("metaBody with tool search and the prompt cache", () => {
  it("sends today's body byte for byte when both are off", () => {
    expect(JSON.stringify(metaBody("muse-spark-1.3", OPERATOR_REQUEST, OPERATOR_OPTIONS))).toBe(BODY_BEFORE);
    // Explicitly off reads the same as left out.
    const off: AiRequest = {
      ...OPERATOR_REQUEST,
      toolSearch: false,
      tools: OPERATOR_REQUEST.tools!.map((t) => ({ ...t, deferLoading: false })),
      messages: OPERATOR_REQUEST.messages.map((m) => (m.role === "system" ? { ...m, placement: "instructions" as const } : m)),
    };
    expect(JSON.stringify(metaBody("muse-spark-1.3", off, OPERATOR_OPTIONS))).toBe(BODY_BEFORE);
    // The auditor's structured-output call on Muse Wonder is unchanged too.
    const audit = metaBody("muse-wonder-1.0", AUDIT_REQUEST, { maxOutputTokens: 2400, reasoningEffort: "high" });
    expect(JSON.stringify(audit)).toBe(AUDIT_BODY_BEFORE);
  });

  it("offers the hosted search first, withholds deferred schemas and keys the cache", () => {
    const request: AiRequest = {
      ...OPERATOR_REQUEST,
      toolSearch: true,
      cache: { key: "ledgerline-operator-0123456789abcdef", retention: "in_memory" },
      tools: OPERATOR_REQUEST.tools!.map((t) => (t.name === "propose_advance" ? { ...t, deferLoading: true } : t)),
      messages: OPERATOR_REQUEST.messages.map((m, i) =>
        i === 1 && m.role === "system" ? { ...m, placement: "input" as const } : m,
      ),
    };
    const body = metaBody("muse-spark-1.3", request, OPERATOR_OPTIONS);
    expect(body.instructions).toBe("You answer for the payroll desk.");
    expect(body.input[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Carrier: Demo Freight. Week: 2026-10-26 to 2026-11-01." }],
    });
    expect(body.tools?.[0]).toEqual({ type: "tool_search" });
    expect(body.tools?.[1]).not.toHaveProperty("defer_loading");
    expect(body.tools?.[2]).toMatchObject({ name: "propose_advance", defer_loading: true });
    expect(body).toMatchObject({ prompt_cache_key: "ledgerline-operator-0123456789abcdef" });
    // in_memory is the API's default and is never sent.
    expect(body).not.toHaveProperty("prompt_cache_retention");
  });

  it("asks for 24 hour retention only when told to", () => {
    const body = metaBody(
      "muse-spark-1.3",
      { ...OPERATOR_REQUEST, cache: { key: "ledgerline-operator-0123456789abcdef", retention: "24h" } },
      OPERATOR_OPTIONS,
    );
    expect(body).toMatchObject({
      prompt_cache_key: "ledgerline-operator-0123456789abcdef",
      prompt_cache_retention: "24h",
    });
    const noRetention = metaBody(
      "muse-spark-1.3",
      { ...OPERATOR_REQUEST, cache: { key: "ledgerline-operator-0123456789abcdef" } },
      OPERATOR_OPTIONS,
    );
    expect(noRetention).not.toHaveProperty("prompt_cache_retention");
  });

  it("sends the search items of the last answer back before its tool call", () => {
    const replay: AiReplayItem[] = [
      { type: "tool_search_call", arguments: { paths: [""] }, call_id: null, execution: "server", status: "completed" },
      { type: "tool_search_output", call_id: null, execution: "server", status: "completed", tools: [] },
    ];
    const body = metaBody(
      "muse-spark-1.3",
      { ...OPERATOR_REQUEST, toolSearch: true, replay, tools: OPERATOR_REQUEST.tools!.map((t) => ({ ...t, deferLoading: true })) },
      OPERATOR_OPTIONS,
    );
    expect(body.input.slice(1, 3)).toEqual(replay);
    expect((body.input[3] as { type: string }).type).toBe("function_call");
  });
});

describe("parseMeta with a hosted tool search", () => {
  it("keeps the search items for replay without their ids, counts the search, and reads the tool call", () => {
    const outcome = parseMeta(
      {
        id: "resp_search1",
        status: "completed",
        output: [
          {
            type: "tool_search_call",
            id: "ts_1",
            arguments: { paths: [""] },
            call_id: null,
            execution: "server",
            status: "completed",
          },
          {
            type: "tool_search_output",
            id: "tso_1",
            call_id: null,
            execution: "server",
            status: "completed",
            tools: [{ type: "function", name: "propose_advance" }],
          },
          { type: "function_call", call_id: "call_2", name: "propose_advance", arguments: '{"cents":5000}' },
        ],
        usage: { ...USAGE, input_tokens: 9200, input_tokens_details: { cached_tokens: 3185 } },
      },
      200,
    );
    expect(outcome).toMatchObject({
      kind: "answered",
      metered: { unit: "tokens", usage: { input: 9200, cached: 3185 } },
      value: {
        toolCalls: [{ id: "call_2", name: "propose_advance", argumentsJson: '{"cents":5000}' }],
        replay: [
          { type: "tool_search_call", arguments: { paths: [""] }, call_id: null, execution: "server", status: "completed" },
          {
            type: "tool_search_output",
            call_id: null,
            execution: "server",
            status: "completed",
            tools: [{ type: "function", name: "propose_advance" }],
          },
        ],
        toolSearches: 1,
      },
    });
    if (outcome.kind !== "answered") throw new Error("expected an answer");
    for (const item of outcome.value.replay) expect(item).not.toHaveProperty("id");
  });
});
