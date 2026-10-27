import { describe, expect, it } from "vitest";
import { parseBaseten } from "./baseten";
import { FIREWORKS_CHAT_URL, parseFireworks, withoutLeadingThink } from "./fireworks";

const USAGE = {
  prompt_tokens: 20,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens: 30,
  completion_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 50,
};

function answer(message: Record<string, unknown>, finish = "stop") {
  return {
    id: "fw-cmpl-9",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
    usage: USAGE,
  };
}

const UNREADABLE = { kind: "unknown", category: "unknown", httpStatus: 200 };

describe("FIREWORKS_CHAT_URL", () => {
  it("is Fireworks' OpenAI-compatible chat endpoint, over https", () => {
    expect(FIREWORKS_CHAT_URL).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
  });
});

describe("withoutLeadingThink", () => {
  it("removes exactly one leading think block and the space after it", () => {
    expect(withoutLeadingThink("<think>Plan.</think>\n\nAnswer.")).toBe("Answer.");
    expect(withoutLeadingThink("\n <think>\nPlan.\n</think>Answer.")).toBe("Answer.");
    expect(withoutLeadingThink("<think></think>")).toBe("");
  });

  it("leaves text with no think tag as it is", () => {
    expect(withoutLeadingThink("Answer.")).toBe("Answer.");
    expect(withoutLeadingThink("")).toBe("");
    expect(withoutLeadingThink("  Answer with <thinking> in it.  ")).toBe(
      "  Answer with <thinking> in it.  ",
    );
  });

  it("refuses any think tag it does not know how to read", () => {
    for (const content of [
      "<think>Never closed",
      "<think>a<think>b</think>c</think>Answer.",
      "<think>a</think><think>b</think>Answer.",
      "<think>a</think>Answer.</think>",
      "<think>a</think>Answer. <think",
      "Answer.</think>",
      "Answer. <think>x</think>",
      "<THINK>x</THINK>Answer.",
      "<Think>x</Think>Answer.",
      "<think attr>x</think>Answer.",
      "<think>a <think b</think>Answer.",
    ]) {
      expect(withoutLeadingThink(content), content).toBeNull();
    }
  });
});

describe("parseFireworks", () => {
  it("reads the shape Baseten's parser reads, exactly as it does, when there is no think block", () => {
    const json = answer({ content: "triage: load" });
    expect(parseFireworks(json, 200)).toEqual(parseBaseten(json, 200));
    expect(parseFireworks(json, 200)).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: "fw-cmpl-9",
      metered: { unit: "tokens", usage: { input: 20, cached: 4, output: 30, reasoning: 10 } },
      value: { text: "triage: load", toolCalls: [], replay: [] },
    });
  });

  it("drops a leading think block from the text only, keeping tool calls, usage and status", () => {
    const outcome = parseFireworks(
      answer(
        {
          content: "<think>Find the load first.</think>\n",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "find_load", arguments: '{"id":"L-1"}' },
            },
          ],
        },
        "tool_calls",
      ),
      200,
    );
    expect(outcome).toMatchObject({
      kind: "answered",
      status: "ok",
      metered: { unit: "tokens", usage: { input: 20, cached: 4, output: 30, reasoning: 10 } },
      value: {
        text: "",
        toolCalls: [{ id: "call_1", name: "find_load", argumentsJson: '{"id":"L-1"}' }],
      },
    });
  });

  it("ignores a separate reasoning field", () => {
    const outcome = parseFireworks(
      answer({ content: "triage: load", reasoning_content: "<think>hidden" }),
      200,
    );
    expect(outcome).toMatchObject({ kind: "answered", value: { text: "triage: load" } });
  });

  it("reads null or missing content as empty text, as Baseten's parser does", () => {
    for (const message of [{ content: null }, {}]) {
      expect(parseFireworks(answer(message), 200)).toMatchObject({
        kind: "answered",
        value: { text: "" },
      });
    }
  });

  it("is unreadable for content that is not text, or a think block it does not know", () => {
    for (const content of [
      [{ type: "text", text: "triage: load" }],
      { text: "triage: load" },
      42,
      true,
      "<think>Never closed",
      "<think>a<think>b</think></think>triage: load",
    ]) {
      expect(parseFireworks(answer({ content }), 200), JSON.stringify(content)).toEqual(UNREADABLE);
    }
  });

  it("is unreadable for an output budget that ran out inside the think block", () => {
    expect(parseFireworks(answer({ content: "<think>Still planning" }, "length"), 200)).toEqual(
      UNREADABLE,
    );
    // Cut off after the block: an incomplete answer, read like any other.
    expect(parseFireworks(answer({ content: "<think>a</think>tri" }, "length"), 200)).toMatchObject(
      { kind: "answered", status: "incomplete", value: { text: "tri" } },
    );
  });

  it("is unreadable for every shape Baseten's parser refuses", () => {
    for (const json of [
      null,
      "text",
      [],
      {},
      { choices: [] },
      { ...answer({ content: "x" }), usage: undefined },
      { ...answer({ content: "x" }), usage: { prompt_tokens: 1 } },
      { ...answer({ content: "x" }), choices: [{ finish_reason: "stop" }] },
    ]) {
      expect(parseFireworks(json, 200), JSON.stringify(json)).toEqual(UNREADABLE);
    }
  });
});
