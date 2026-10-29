import { describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DEMO_CARRIERS } from "../seed/carriers";
import { cashPositionOf } from "../seed/cash-plan";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { cents, type CashOption, type CashPosition, type ChaseOption } from "../rules-engine";
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
    const { facts, guard } = explainFacts(short.result, input.billCategory);
    expect(facts).toMatchObject({
      payDay: "Friday, Nov 6",
      verdict: "short",
      gap: "$6,800.00",
      payRunIs: "a preview of this week's pay",
    });
    expect((facts.moves as unknown[]).length).toBe(4);
    expect(guard.allowed.has(680_000)).toBe(true);
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

  it("gives each chase the engine's new cash and whether it alone covers the short", () => {
    const { facts, guard } = explainFacts(short.result, input.billCategory);
    const chases = short.result.options.filter((o) => o.kind === "collections_chase");
    expect(chases.length).toBeGreaterThan(0);
    const given = (facts.moves as Record<string, unknown>[]).filter((m) => "pastDue" in m);
    expect(given).toEqual(
      chases.map((o) => ({
        move: "ask a late-paying customer for what is past due (test mode: nothing is sent)",
        pastDue: dollars(o.amountCents),
        newCash: dollars(o.newCashCents),
        pastDueInvoices: o.overdueInvoices,
        coversShort: o.coversShort,
      })),
    );
    for (const o of chases) expect(guard.allowed.has(o.newCashCents)).toBe(true);
  });
});

// The overstated chase: the short is $800.00, and a customer's $1,000.00 past-due invoice already
// counts $500.00 in expected receipts, so chasing it adds $500.00 (the engine's newCashCents) and
// does not cover the short. The position's own figures are chosen to share no amount with a move.
function chase(over: Partial<ChaseOption> = {}): ChaseOption {
  return {
    kind: "collections_chase",
    subjectTable: "customers",
    subjectId: "cust-1",
    direction: "in",
    amountCents: cents(100_000),
    newCashCents: cents(50_000),
    coversShort: false,
    label: "mixed",
    overdueInvoices: 1,
    invoices: [],
    sources: [],
    ...over,
  };
}

function shortBy800(options: CashOption[]): CashPosition {
  return {
    ...short.result,
    figures: {
      ...short.result.figures,
      cashOnHandCents: cents(150_000),
      expectedReceiptsCents: cents(70_000),
      payRunCents: cents(250_000),
      fuelLoadsCents: cents(15_000),
      vendorBillsDueCents: cents(35_000),
      gapCents: cents(-80_000),
    },
    options,
  };
}

const guardOf = (r: CashPosition) => explainFacts(r, () => null).guard;

describe("checkExplanation", () => {
  const { guard } = explainFacts(short.result, input.billCategory);

  it("keeps a paragraph whose figures are all the engine's", () => {
    const text = "  Friday is short by $6,800.00.  Moving the shop bill covers it. ";
    expect(checkExplanation(text, guard)).toEqual({
      ok: true,
      text: "Friday is short by $6,800.00. Moving the shop bill covers it.",
    });
  });

  it("drops a paragraph with any other amount, dollar sign or not", () => {
    expect(checkExplanation("Short by $6,800.00, about $7,000 in all.", guard)).toEqual({
      ok: false,
      category: "figures",
    });
    expect(checkExplanation("Short by $6,800.00 of the 1,234.56 needed.", guard)).toEqual({
      ok: false,
      category: "figures",
    });
    expect(checkExplanation("Short by 6,800.00.", guard)).toEqual({ ok: false, category: "figures" });
  });

  it("drops an empty or long paragraph", () => {
    expect(checkExplanation("  ", guard)).toEqual({ ok: false, category: "empty" });
    expect(checkExplanation("a".repeat(flags.cashFridayLimits.maxExplainChars + 1), guard)).toEqual({
      ok: false,
      category: "too_long",
    });
  });

  it("drops a paragraph that says a chase covers the short when its new cash does not", () => {
    const g = guardOf(shortBy800([chase()]));
    expect(g.allowed.has(50_000) && g.allowed.has(100_000)).toBe(true);
    for (const text of [
      "Friday is short by $800.00. Chasing the late payer for the $1,000.00 past due covers the short.",
      "Friday is short by $800.00. Asking the late-paying customer for $1,000.00 is enough to close the gap.",
      "Chasing the late payer brings in $500.00 of new cash. That covers the $800.00 short.",
      "The $1,000.00 past due would cover the $800.00 short, with room to spare.",
      "Collecting what is past due makes up the $800.00 short.",
    ]) {
      expect(checkExplanation(text, g)).toEqual({ ok: false, category: "overclaim" });
    }
  });

  it("keeps a paragraph that says the chase only narrows the short", () => {
    const g = guardOf(shortBy800([chase()]));
    for (const text of [
      "Friday is short by $800.00. Chasing the late payer's $1,000.00 past due adds $500.00 of new cash, " +
        "which narrows the short but does not cover it.",
      "Friday is short by $800.00. Chasing the late payer adds $500.00, not enough to cover the short.",
      "Pay day is not covered: cash on hand of $1,500.00 and $700.00 expected fall short by $800.00.",
    ]) {
      expect(checkExplanation(text, g)).toMatchObject({ ok: true });
    }
  });

  it("keeps a paragraph that says a chase covers the short when its new cash does", () => {
    // A stalled $1,000.00 invoice: the engine expects none of it, so all of it is new cash.
    const g = guardOf(shortBy800([chase({ newCashCents: cents(100_000), coversShort: true })]));
    expect(
      checkExplanation("Friday is short by $800.00. Chasing the late payer for the $1,000.00 past due covers it.", g),
    ).toMatchObject({ ok: true });
  });

  it("reads each move's own claim when one covers and another does not", () => {
    const factoring = short.result.options.find((o) => o.kind === "factoring_request");
    if (!factoring || factoring.kind !== "factoring_request") throw new Error("no factoring move");
    const covering = { ...factoring, amountCents: cents(90_000), feeCents: cents(2_700), coversShort: true };
    const g = guardOf(shortBy800([covering, chase()]));
    expect(
      checkExplanation("Factoring brings in $900.00 and covers the short, while chasing the late payer only narrows it.", g),
    ).toMatchObject({ ok: true });
    expect(checkExplanation("Factoring or chasing the late payer would each cover the short.", g)).toEqual({
      ok: false,
      category: "overclaim",
    });
    expect(checkExplanation("Chasing $1,000.00 past due and factoring together close the gap.", g)).toEqual({
      ok: false,
      category: "overclaim",
    });
  });

  it("reads no move claim in a covered week", () => {
    const { guard: none } = explainFacts(covered.result, () => null);
    expect(checkExplanation("Cash covers pay day, so there is no need to chase anyone.", none)).toMatchObject({
      ok: true,
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

  it("drops a paragraph that says a move covers the short the engine did not mark as covering", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      answer(JSON.stringify({ explanation: "Friday is short by $800.00. Chasing the $1,000.00 past due covers it." })),
    );
    const out = await explainCheck(SESSION, { ...input, result: shortBy800([chase()]) }, { complete });
    expect(out).toEqual({
      ok: false,
      category: "overclaim",
      callId: "c0ffee00-0000-4000-8000-000000000001",
      costNanocents: 400_000_000,
    });
    // The model got the engine's new cash and flag for the chase, never a number to work out.
    const [, request] = complete.mock.calls[0];
    const sent = JSON.parse(String(request.messages[1].content)) as { moves: Record<string, unknown>[] };
    expect(sent.moves).toEqual([
      {
        move: "ask a late-paying customer for what is past due (test mode: nothing is sent)",
        pastDue: "$1,000.00",
        newCash: "$500.00",
        pastDueInvoices: 1,
        coversShort: false,
      },
    ]);
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
