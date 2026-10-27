import { describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DEMO_CARRIERS } from "../seed/carriers";
import { cashPositionOf } from "../seed/cash-plan";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import {
  AiError,
  checkExplanation,
  dayWords,
  dollars,
  engineSentence,
  explainCheck,
  explainFacts,
  type CompleteFn,
} from "./explain";

type AiResult = Awaited<ReturnType<CompleteFn>>;

// The seeded carriers at the golden anchor: Blue Ridge short by $6,800.00 with three moves,
// Prairie Wind covered with $2,140.00 to spare. Pure: no clock, no database, no network.
const plans = Object.fromEntries(
  DEMO_CARRIERS.map((c) => {
    const plan = buildCarrierPlan(c, golden.anchor);
    return [c.slug, { plan, result: cashPositionOf(plan.rows, c, golden.anchor, flags.cashFridayLimits) }];
  }),
);
const short = plans["blue-ridge"];
const covered = plans["prairie-wind"];
const billCategory = (rows: typeof short.plan.rows) => {
  const m = new Map(rows.vendor_bills.map((b) => [b.id, b.category]));
  return (id: string) => m.get(id) ?? null;
};

const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const TRACE = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";

function answer(text: string, status: AiResult["status"] = "ok"): AiResult {
  return {
    callId: "c0ffee00-0000-4000-8000-000000000001",
    status,
    text,
    toolCalls: [],
    usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 120, reasoningTokens: 0 },
    costNanocents: 400_000_000,
    upstreamId: "resp_1",
    replay: [],
  } as unknown as AiResult;
}

const input = { traceId: TRACE, result: short.result, billCategory: billCategory(short.plan.rows) };

describe("explainFacts", () => {
  it("gives the model the engine's figures as dollars and the moves, nothing a person wrote", () => {
    const { facts, allowed } = explainFacts(short.result, input.billCategory);
    expect(facts).toMatchObject({
      payDay: "Friday, Nov 6",
      verdict: "short",
      gap: "$6,800.00",
      payRunIs: "a preview of this week's pay",
    });
    expect((facts.moves as unknown[]).length).toBe(4);
    expect(allowed.has(680_000)).toBe(true);
    // No vendor, customer or driver name, no memo, no record id goes out.
    const sent = JSON.stringify(facts);
    for (const b of short.plan.rows.vendor_bills) expect(sent).not.toContain(b.vendor_name);
    for (const c of short.plan.rows.customers) expect(sent).not.toContain(c.name);
    for (const d of short.plan.rows.drivers) expect(sent).not.toContain(d.code);
    expect(sent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    for (const p of short.plan.rows.customer_payments) {
      if (p.memo) expect(sent).not.toContain(p.memo);
    }
  });

  it("names the bill by its category only", () => {
    const { facts } = explainFacts(short.result, input.billCategory);
    const defer = (facts.moves as Record<string, unknown>[]).find((m) => "bill" in m);
    expect(defer).toMatchObject({ bill: "shop and tires", newDueDate: "Friday, Nov 13", coversShort: true });
  });
});

describe("checkExplanation", () => {
  const { allowed } = explainFacts(short.result, input.billCategory);

  it("keeps a paragraph whose figures are all the engine's", () => {
    const text = "  Friday is short by $6,800.00.  Moving the shop bill covers it. ";
    expect(checkExplanation(text, allowed)).toEqual({
      ok: true,
      text: "Friday is short by $6,800.00. Moving the shop bill covers it.",
    });
  });

  it("drops a paragraph with any other amount, dollar sign or not", () => {
    expect(checkExplanation("Short by $6,800.00, about $7,000 in all.", allowed)).toEqual({
      ok: false,
      category: "figures",
    });
    expect(checkExplanation("Short by $6,800.00 of the 1,234.56 needed.", allowed)).toEqual({
      ok: false,
      category: "figures",
    });
    expect(checkExplanation("Short by 6,800.00.", allowed)).toEqual({ ok: false, category: "figures" });
  });

  it("drops an empty or long paragraph", () => {
    expect(checkExplanation("  ", allowed)).toEqual({ ok: false, category: "empty" });
    expect(checkExplanation("a".repeat(flags.cashFridayLimits.maxExplainChars + 1), allowed)).toEqual({
      ok: false,
      category: "too_long",
    });
  });
});

describe("explainCheck", () => {
  it("asks Muse Wonder once, under the check's own cap and token limit, as strict JSON", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      answer(JSON.stringify({ explanation: "Friday is short by $6,800.00. Delaying the shop bill covers it." })),
    );
    const out = await explainCheck(SESSION, input, { complete });
    expect(out).toEqual({
      ok: true,
      text: "Friday is short by $6,800.00. Delaying the shop bill covers it.",
      callId: "c0ffee00-0000-4000-8000-000000000001",
      costNanocents: 400_000_000,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const [target, request, session] = complete.mock.calls[0];
    expect(target).toBe("wonder");
    expect(session).toBe(SESSION);
    expect(request).toMatchObject({
      purpose: "cash_friday_explain",
      maxCostCents: flags.cashFridayLimits.maxExplainCents,
      maxOutputTokens: 600,
      reasoningEffort: "low",
      traceId: TRACE,
      format: { strict: true },
    });
    expect(request.messages).toHaveLength(2);
  });

  it("drops a paragraph with a figure the engine did not give", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      answer(JSON.stringify({ explanation: "Friday is short by $6,900.00." })),
    );
    expect(await explainCheck(SESSION, input, { complete })).toMatchObject({ ok: false, category: "figures" });
  });

  it("stores incomplete and unreadable answers as categories", async () => {
    const cut = vi.fn<CompleteFn>(async () => answer('{"explanation": "Friday is', "incomplete"));
    expect(await explainCheck(SESSION, input, { complete: cut })).toMatchObject({
      ok: false,
      category: "incomplete",
      callId: "c0ffee00-0000-4000-8000-000000000001",
    });
    const prose = vi.fn<CompleteFn>(async () => answer("Friday is short."));
    expect(await explainCheck(SESSION, input, { complete: prose })).toMatchObject({ ok: false, category: "bad_answer" });
    const wrong = vi.fn<CompleteFn>(async () => answer(JSON.stringify({ text: "Friday is short." })));
    expect(await explainCheck(SESSION, input, { complete: wrong })).toMatchObject({ ok: false, category: "bad_answer" });
  });

  it("keeps the wrapper's category for a job cap or a timeout, and never an error's text", async () => {
    for (const category of ["job_cap", "timeout"] as const) {
      const complete = vi.fn<CompleteFn>(async () => {
        throw new AiError(category);
      });
      expect(await explainCheck(SESSION, input, { complete })).toEqual({
        ok: false,
        category,
        callId: null,
        costNanocents: null,
      });
    }
    const odd = vi.fn<CompleteFn>(async () => {
      throw new Error("BR-NTB-2229 upstream said no");
    });
    expect(await explainCheck(SESSION, input, { complete: odd })).toEqual({
      ok: false,
      category: "unknown",
      callId: null,
      costNanocents: null,
    });
  });
});

describe("engineSentence", () => {
  it("adds up the short from the engine's figures, in the order the gap is built", () => {
    const f = short.result.figures;
    expect(engineSentence(short.result.payDay, f)).toBe(
      `Cash on hand ${dollars(f.cashOnHandCents)} plus ${dollars(f.expectedReceiptsCents)} expected by Friday, Nov 6 ` +
        `does not cover the ${dollars(f.payRunCents)} pay run, ${dollars(f.fuelLoadsCents)} of fuel card loads and ` +
        `${dollars(f.vendorBillsDueCents)} of bills due. Short by $6,800.00.`,
    );
  });

  it("says a covered week with what is to spare", () => {
    expect(engineSentence(covered.result.payDay, covered.result.figures)).toMatch(
      /^Cash on hand \$[\d,]+\.\d{2} plus \$[\d,]+\.\d{2} expected by Friday, Nov 6 covers the \$[\d,]+\.\d{2} pay run, .* with \$2,140\.00 to spare\.$/,
    );
  });

  it("writes an overdrawn account with a minus sign", () => {
    const f = { ...short.result.figures, cashOnHandCents: -12_345 };
    expect(engineSentence("2026-11-06", f)).toMatch(/^Cash on hand -\$123\.45 plus /);
  });

  it("names the weekday from the date alone", () => {
    expect(dayWords("2026-11-13")).toBe("Friday, Nov 13");
    expect(dayWords("2026-11-01")).toBe("Sunday, Nov 1");
  });
});
