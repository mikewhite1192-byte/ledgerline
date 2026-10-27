import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../auth/claims";
import type { CompleteFn } from "../gateway/types";
import { AiError, checkExplanation, explainFix, type ExplainInput } from "./explain";

type AiResult = Awaited<ReturnType<CompleteFn>>;

const SESSION: Session = { sub: "service:sweep:t", email: "sweep@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const INPUT: ExplainInput = {
  traceId: "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e",
  check: "duplicate_advance",
  category: "newer_is_duplicate",
  reasonCategory: "duplicate_charge",
  driverCode: "BR-D17",
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  expectedCents: 34000,
  maxCostCents: 5,
};

function result(text: string, status: AiResult["status"] = "ok"): AiResult {
  return {
    callId: "c0ffee00-0000-4000-8000-000000000001",
    status,
    text,
    toolCalls: [],
    usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 80, reasoningTokens: 0 },
    costNanocents: 120_000_000,
    upstreamId: "resp_1",
    replay: [],
  } as unknown as AiResult;
}

describe("checkExplanation", () => {
  it("keeps a paragraph whose only figure is the engine's amount", () => {
    expect(checkExplanation("  The second $340.00 advance  repeats the first. ", 34000)).toEqual({
      ok: true,
      text: "The second $340.00 advance repeats the first.",
    });
    expect(checkExplanation("Moves $286.40 off BR-D18.", -28640)).toMatchObject({ ok: true });
  });

  it("drops a paragraph with any other amount, dollar sign or not", () => {
    expect(checkExplanation("Adds $340.00, so net is $1,210.55.", 34000)).toEqual({ ok: false, category: "figures" });
    expect(checkExplanation("Adds $340.00 to the 870.25 net.", 34000)).toEqual({ ok: false, category: "figures" });
    expect(checkExplanation("Adds $34.00.", 34000)).toEqual({ ok: false, category: "figures" });
  });

  it("drops an empty or long paragraph", () => {
    expect(checkExplanation("   ", 34000)).toEqual({ ok: false, category: "empty" });
    expect(checkExplanation("a".repeat(401), 34000)).toEqual({ ok: false, category: "too_long" });
  });
});

describe("explainFix", () => {
  it("asks Spark once, under the fix's own small cap and token limit, with the engine's amount", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      result(JSON.stringify({ explanation: "BR-D17 was charged the same $340.00 advance twice." })),
    );
    const out = await explainFix(SESSION, INPUT, { complete });
    expect(out).toEqual({
      ok: true,
      text: "BR-D17 was charged the same $340.00 advance twice.",
      callId: "c0ffee00-0000-4000-8000-000000000001",
      costNanocents: 120_000_000,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const [target, request, session] = complete.mock.calls[0];
    expect(target).toBe("spark");
    expect(session).toBe(SESSION);
    expect(request).toMatchObject({ purpose: "sweep_explain", maxCostCents: 5, maxOutputTokens: 400, traceId: INPUT.traceId });
    const finding = JSON.parse(request.messages[1].content as string);
    expect(finding).toMatchObject({ amount: "$340.00", correction: "adds to the driver's pay", driver: "BR-D17" });
  });

  it("drops an answer with a figure the engine did not give, but keeps the call's cost", async () => {
    const complete = vi.fn<CompleteFn>(async () => result(JSON.stringify({ explanation: "Refund $400.00." })));
    await expect(explainFix(SESSION, INPUT, { complete })).resolves.toEqual({
      ok: false,
      category: "figures",
      callId: "c0ffee00-0000-4000-8000-000000000001",
      costNanocents: 120_000_000,
    });
  });

  it("names bad and unfinished answers by category", async () => {
    const bad = vi.fn<CompleteFn>(async () => result("not json"));
    await expect(explainFix(SESSION, INPUT, { complete: bad })).resolves.toMatchObject({ ok: false, category: "bad_answer" });
    const cut = vi.fn<CompleteFn>(async () => result("", "incomplete" as AiResult["status"]));
    await expect(explainFix(SESSION, INPUT, { complete: cut })).resolves.toMatchObject({ ok: false, category: "incomplete" });
  });

  it("never throws for a model failure, and keeps only the category", async () => {
    const capped = vi.fn<CompleteFn>(async () => {
      throw new AiError("cap");
    });
    await expect(explainFix(SESSION, INPUT, { complete: capped })).resolves.toEqual({
      ok: false,
      category: "cap",
      callId: null,
      costNanocents: null,
    });
    const odd = vi.fn<CompleteFn>(async () => {
      throw new Error("upstream said something with a row in it");
    });
    await expect(explainFix(SESSION, INPUT, { complete: odd })).resolves.toEqual({
      ok: false,
      category: "unknown",
      callId: null,
      costNanocents: null,
    });
  });
});
