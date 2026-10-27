import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { AiRequest, AiResult } from "../../../ai";
import type { Queryable } from "../../../db";
import { MAX_MESSAGE_CHARS, UNTRUSTED_WARNING } from "../tools/read/get-inbound-message";
import { getVoiceNote, VOICE_NOTE_SQL } from "../tools/read/get-voice-note";
import { runTriage, TRIAGE_PURPOSE, triageTarget } from "../triage/run";
import type { ScreenVerdict } from "../types";
import { context, FakeDb, fixedClock, NOW } from "./fake-db";

// The voice note's two gateway pieces: get_voice_note (a screened read, its text always inside
// the warning) and the triage sort (one classify_message call through the gateway, anything else
// is "other"). Scripted database and model; no network.

const saved = structuredClone(flags);
beforeEach(() => Object.assign(flags, structuredClone(saved)));
afterEach(() => Object.assign(flags, structuredClone(saved)));

const INPUT = "44444444-4444-4444-8444-444444444444";
const NOTE = "33333333-3333-4333-8333-333333333333";
const DRIVER = "22222222-2222-4222-8222-222222222222";

const verdict = (v: "clean" | "flagged"): ScreenVerdict => ({
  inputId: INPUT,
  verdict: v,
  categories: v === "flagged" ? ["instruction_to_agent"] : [],
  confidence: null,
  contentHash: "h",
  via: "model",
  modelCallId: null,
  screenerVersion: 1,
});

describe("get_voice_note", () => {
  function q(rows: Record<string, unknown>[]): Queryable & { seen: unknown[][] } {
    const seen: unknown[][] = [];
    return {
      seen,
      async query<T>(sql: string, params: unknown[] = []) {
        seen.push([sql, ...params]);
        return rows as T[];
      },
      async execute() {
        return 0;
      },
    };
  }
  const note = {
    id: NOTE,
    driver_id: DRIVER,
    status: "handed_off",
    language: "es",
    english_text: "I need a $300 advance for diesel.",
    triage_category: "advance_request",
    triage_urgency: "normal",
    amount_cents: "30000",
  };
  const run = (db: Queryable, screen?: ScreenVerdict) =>
    getVoiceNote.run(db, context(), { inputId: INPUT }, { screen: screen ?? null, limit: null });

  it("is a screened read for the operator, keyed by the transcript's input", () => {
    expect(getVoiceNote.tier).toBe("read");
    expect(getVoiceNote.roles).toEqual(["operator"]);
    expect(getVoiceNote.screens?.({ inputId: INPUT })).toBe(INPUT);
    expect(getVoiceNote.refs({ inputId: INPUT })).toEqual([{ table: "untrusted_inputs", id: INPUT }]);
    expect(VOICE_NOTE_SQL).toContain("tenant_id = current_tenant_id()");
    expect(VOICE_NOTE_SQL).toContain("status IN ('ready', 'handed_off', 'replied')");
  });

  it("refuses to run without a screen verdict", async () => {
    await expect(run(q([note]))).rejects.toThrow();
  });

  it("returns the English copy inside the warning, with the screen's verdict", async () => {
    const db = q([note]);
    const { result } = await run(db, verdict("flagged"));
    expect(db.seen[0][1]).toBe(INPUT);
    expect(result).toEqual({
      inputId: INPUT,
      found: true,
      voiceNoteId: NOTE,
      fromDriverId: DRIVER,
      language: "es",
      category: "advance_request",
      urgency: "normal",
      amountCents: 30_000,
      screened: true,
      verdict: "flagged",
      categories: ["instruction_to_agent"],
      warning: UNTRUSTED_WARNING,
      text: "I need a $300 advance for diesel.",
      truncated: false,
    });
  });

  it("cuts a long copy to the message cap and drops an amount that is not whole cents", async () => {
    const { result } = await run(q([{ ...note, english_text: "x".repeat(MAX_MESSAGE_CHARS + 10), amount_cents: "1.5" }]), verdict("clean"));
    expect((result.text as string).length).toBe(MAX_MESSAGE_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.amountCents).toBeNull();
  });

  it("says not found for a note that is missing or not ready", async () => {
    expect((await run(q([]), verdict("clean"))).result).toEqual({ inputId: INPUT, found: false });
    expect((await run(q([{ ...note, english_text: null }]), verdict("clean"))).result).toEqual({ inputId: INPUT, found: false });
  });
});

describe("runTriage", () => {
  const answer = (toolCalls: AiResult["toolCalls"]): AiResult => ({
    callId: "66666666-6666-4666-8666-666666666666",
    status: "ok",
    text: "",
    toolCalls,
    usage: {} as AiResult["usage"],
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  });
  const classify = (args: Record<string, unknown>, name = "classify_message") => ({
    id: "call-1",
    name,
    argumentsJson: JSON.stringify(args),
  });
  const ctx = context({ role: "triage", model: "spark_open", deadlineAt: NOW + 27_000 });

  function setup(toolCalls: AiResult["toolCalls"]) {
    const db = new FakeDb({ untrusted_inputs: [{ id: INPUT }], drivers: [{ id: DRIVER }] });
    const sent: { target: string; request: AiRequest }[] = [];
    const deps = {
      db,
      clock: fixedClock,
      complete: async (target: string, request: AiRequest) => {
        sent.push({ target, request });
        return answer(toolCalls);
      },
    };
    return { db, sent, deps };
  }

  it("keeps one valid classification that passed the gateway, and logs the decision", async () => {
    flags.triageProvider = "baseten";
    const { db, sent, deps } = setup([classify({ inputId: INPUT, category: "advance_request", urgency: "high", driverId: DRIVER })]);
    expect(await runTriage(ctx, { text: "I need $300.", inputId: INPUT }, deps as never)).toEqual({
      category: "advance_request",
      urgency: "high",
      callId: "66666666-6666-4666-8666-666666666666",
      decided: true,
    });
    expect(triageTarget()).toBe("spark_open");
    expect(sent[0].target).toBe("spark_open");
    expect(sent[0].request.purpose).toBe(TRIAGE_PURPOSE);
    expect(sent[0].request.timeoutMs).toBe(12_000);
    expect(sent[0].request.tools?.map((t) => t.name)).toEqual(["classify_message"]);
    const user = sent[0].request.messages[1].content as string;
    expect(user).toContain(UNTRUSTED_WARNING);
    expect(user).toContain(`Input id: ${INPUT}`);
    expect(db.decisions.map((d) => [d.tool, d.role, d.decision])).toEqual([["classify_message", "triage", "allowed"]]);
  });

  it.each([
    ["no tool call", []],
    ["another tool", [classify({ inputId: INPUT, category: "advance_request", urgency: "high" }, "get_voice_note")]],
    ["a category outside the list", [classify({ inputId: INPUT, category: "pay_me_now", urgency: "high" })]],
    ["another input", [classify({ inputId: "0f1e2d3c-4b5a-4968-8776-655443322110", category: "advance_request", urgency: "high" })]],
    ["bad JSON", [{ id: "call-1", name: "classify_message", argumentsJson: "{" }]],
  ])("sorts %s as other", async (_label, calls) => {
    const { deps } = setup(calls as AiResult["toolCalls"]);
    expect(await runTriage(ctx, { text: "Hola", inputId: INPUT }, deps as never)).toMatchObject({
      category: "other",
      urgency: "normal",
      decided: false,
    });
  });
});
