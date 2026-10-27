import { describe, expect, it } from "vitest";
import {
  CHAT_PATH,
  emptyFixture,
  fingerprint,
  fingerprintParts,
  labelOf,
  parseFixture,
  RESPONSES_PATH,
  serializeFixture,
  stampForReplay,
  stripForFixture,
} from "./replay";

const tool = (name: string) => ({ type: "function", name, description: "d", parameters: {} });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

function responsesBody(over: Record<string, unknown> = {}) {
  return {
    model: "muse-spark-1.3",
    instructions: "You are the operator. Today is 2026-10-27.",
    input: [user("Who has a problem on this week's paystub?")],
    tools: [tool("read_paystub"), tool("list_drivers")],
    max_output_tokens: 900,
    ...over,
  };
}

describe("fingerprintParts", () => {
  it("reads the model, sorted tool names, tool results and the last user text", () => {
    const body = responsesBody({
      input: [
        user("first question"),
        { type: "function_call", call_id: "c1", name: "list_drivers", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "[]" },
        user("second question"),
        { type: "function_call", call_id: "c2", name: "read_paystub", arguments: "{}" },
        { type: "function_call_output", call_id: "c2", output: "{}" },
      ],
    });
    expect(fingerprintParts(RESPONSES_PATH, body)).toEqual({
      path: RESPONSES_PATH,
      model: "muse-spark-1.3",
      tools: ["list_drivers", "read_paystub"],
      toolResults: 2,
      user: "second question",
      format: "",
    });
  });

  it("matches a structured-output request by its format, never by its changing evidence", () => {
    const a = responsesBody({
      model: "muse-wonder-1.0",
      tools: undefined,
      input: [user(JSON.stringify({ proposalId: "a1", at: "2026-10-27T01:00:00Z" }))],
      text: { format: { type: "json_schema", name: "audit_verdict", schema: {} } },
    });
    const b = { ...a, input: [user(JSON.stringify({ proposalId: "b2", at: "2026-11-05T09:00:00Z" }))] };
    expect(fingerprintParts(RESPONSES_PATH, a)).toMatchObject({ user: "", format: "audit_verdict", tools: [] });
    expect(fingerprint(fingerprintParts(RESPONSES_PATH, a))).toBe(fingerprint(fingerprintParts(RESPONSES_PATH, b)));
  });

  it("ignores what changes between runs: instructions, dates, tool order and tool results' text", () => {
    const a = responsesBody();
    const b = responsesBody({
      instructions: "You are the operator. Today is 2026-11-04.",
      tools: [tool("list_drivers"), tool("read_paystub")],
    });
    expect(fingerprint(fingerprintParts(RESPONSES_PATH, a))).toBe(fingerprint(fingerprintParts(RESPONSES_PATH, b)));
  });

  it("tells apart a different question, model, tool set, step or format", () => {
    const base = fingerprint(fingerprintParts(RESPONSES_PATH, responsesBody()));
    const variants = [
      responsesBody({ input: [user("Another question")] }),
      responsesBody({ model: "muse-wonder-1.0" }),
      responsesBody({ tools: [tool("read_paystub")] }),
      responsesBody({
        input: [user("Who has a problem on this week's paystub?"), { type: "function_call_output", call_id: "c", output: "" }],
      }),
      responsesBody({ text: { format: { name: "other" } } }),
    ];
    const prints = variants.map((v) => fingerprint(fingerprintParts(RESPONSES_PATH, v)));
    expect(new Set([base, ...prints]).size).toBe(variants.length + 1);
  });

  it("reads the chat completions shape too", () => {
    const body = {
      model: "meta-models/muse-spark-open-1026",
      messages: [
        { role: "system", content: "screen this" },
        { role: "user", content: "an advance request" },
        { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "x", content: "{}" },
      ],
      tools: [{ type: "function", function: { name: "screen_request", parameters: {} } }],
    };
    expect(fingerprintParts(CHAT_PATH, body)).toEqual({
      path: CHAT_PATH,
      model: "meta-models/muse-spark-open-1026",
      tools: ["screen_request"],
      toolResults: 1,
      user: "an advance request",
      format: "",
    });
  });

  it("labels a fingerprint with what to re-record, clipped", () => {
    const label = labelOf(fingerprintParts(RESPONSES_PATH, responsesBody({ input: [user("x".repeat(200))] })));
    expect(label).toContain("muse-spark-1.3 /v1/responses tools=2 results=0 user \"");
    expect(label.length).toBeLessThan(160);
  });
});

describe("the fixture", () => {
  it("keeps no reasoning item and no upstream id", () => {
    const recorded = {
      id: "resp_real",
      object: "response",
      status: "completed",
      model: "muse-spark-1.3",
      organization: "not kept",
      output: [
        { id: "rs_1", type: "reasoning", encrypted_content: "opaque" },
        { id: "fc_1", type: "function_call", call_id: "call_real", name: "read_paystub", arguments: "{}" },
        { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const kept = stripForFixture(RESPONSES_PATH, recorded);
    expect(kept).toEqual({
      object: "response",
      status: "completed",
      model: "muse-spark-1.3",
      output: [
        { type: "function_call", name: "read_paystub", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const chat = stripForFixture(CHAT_PATH, {
      id: "chatcmpl_real",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_real", type: "function" }] } }],
    });
    expect(chat).toEqual({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ type: "function" }] } }],
    });
  });

  it("stamps fresh ids on every replay, leaving the fixture untouched", () => {
    const body = stripForFixture(RESPONSES_PATH, {
      status: "completed",
      output: [{ type: "function_call", call_id: "call_real", name: "f", arguments: "{}" }],
      usage: {},
    });
    const a = stampForReplay(RESPONSES_PATH, body);
    const b = stampForReplay(RESPONSES_PATH, body);
    expect(a.id).not.toBe(b.id);
    const callA = (a.output as Array<Record<string, unknown>>)[0];
    const callB = (b.output as Array<Record<string, unknown>>)[0];
    expect(callA.call_id).not.toBe(callB.call_id);
    expect(callA.call_id).toMatch(/^call_e2e_/);
    expect((body.output as Array<Record<string, unknown>>)[0].call_id).toBeUndefined();

    const chat = stampForReplay(CHAT_PATH, {
      choices: [{ message: { role: "assistant", tool_calls: [{ id: "x", function: { name: "f" } }] } }],
    });
    expect(String(chat.id)).toMatch(/^chatcmpl_e2e_/);
  });

  it("round-trips sorted and refuses a malformed file", () => {
    const fixture = emptyFixture("2026-10-27");
    fixture.entries["ffffffffffffffff"] = { label: "b", path: RESPONSES_PATH, body: { status: "completed" } };
    fixture.entries["0000000000000000"] = { label: "a", path: CHAT_PATH, body: { choices: [] } };
    const text = serializeFixture(fixture);
    expect(text.indexOf("0000000000000000")).toBeLessThan(text.indexOf("ffffffffffffffff"));
    expect(parseFixture(text)).toEqual(fixture);
    expect(() => parseFixture("{}")).toThrow();
    expect(() => parseFixture(JSON.stringify({ version: 1, recordedOn: "x", entries: { short: {} } }))).toThrow();
    expect(() => parseFixture("not json")).toThrow();
  });

  it("writes plain ASCII that parses back to the same text", () => {
    const fixture = emptyFixture("2026-10-27");
    const said = "Net is $0.00 \u2014 carried forward \u{1F69A} caf\u00e9";
    fixture.entries["0123456789abcdef"] = { label: "x", path: RESPONSES_PATH, body: { said } };
    const text = serializeFixture(fixture);
    expect(text).toMatch(/^[\x00-\x7f]*$/);
    expect(text).toContain("\\u2014");
    expect(parseFixture(text).entries["0123456789abcdef"].body.said).toBe(said);
  });
});
