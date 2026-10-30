import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { checkPayCard, checkRequest, compareCard, normText } from "./check";
import type { CardRead } from "./schema";
import { cardSpec, type CardSpec } from "./spec";

// The check's comparison, in code: whole values only, numbers before words, and anything printed
// that the card should not show is a difference. The switches and the size check answer before
// any database or model.

const spec = cardSpec({
  carrierName: "Blue Ridge Freight",
  settlement: {
    id: "5b2c8f0e-1d1a-4c55-9a51-7f3e5d6a0b11",
    status: "approved",
    gross_cents: 141_200,
    deductions_cents: 23_450,
    net_cents: 117_750,
    carry_forward_cents: 0,
  },
  period: { period_start: "2026-10-19", period_end: "2026-10-25" },
  driver: { id: "c1f0a9d2-3b4e-4f60-8a71-92b3c4d5e6f7", first_name: "Ana", preferred_language: "en" },
  lines: [
    { kind: "load_pay", amount_cents: 141_200, sources: [{ table: "loads", id: "L-1" }], meta: { loadedMiles: 1_000, emptyMiles: 50 } },
    { kind: "fuel", amount_cents: -23_450, sources: [], meta: null },
  ],
  previousNetCents: 110_000,
  previousLines: [
    { kind: "load_pay", amount_cents: 130_000 },
    { kind: "fuel", amount_cents: -20_000 },
  ],
}) as CardSpec;

const good: CardRead = {
  net_pay_cents: 117_750,
  earned_cents: 141_200,
  taken_out_cents: 23_450,
  loads: 1,
  miles: 1_050,
  change_cents: 7_750,
  first_name: "Ana",
  week_text: "Week of Oct 19 to Oct 25, 2026",
  other_amounts_cents: [11_200],
  any_other_digits: false,
};

describe("compareCard", () => {
  it("passes a read of exactly the card's figures and words", () => {
    expect(spec.topChange).toEqual({ kind: "load_pay", deltaCents: 11_200 });
    expect(compareCard(spec, good)).toBeNull();
    // Another amount the card prints may be read with a sign.
    expect(compareCard(spec, { ...good, other_amounts_cents: [-11_200] })).toBeNull();
  });

  it("wants every amount the card prints in the read, so a missing line is a difference", () => {
    // The biggest change line left out.
    expect(compareCard(spec, { ...good, other_amounts_cents: [] })).toBe("number_mismatch");
    // A carried shortfall the card prints, read without it, then with it.
    const carried = { ...spec, carriedCents: -5_000, amountsCents: [...spec.amountsCents, 5_000] };
    expect(compareCard(carried, good)).toBe("number_mismatch");
    expect(compareCard(carried, { ...good, other_amounts_cents: [11_200, 5_000] })).toBeNull();
  });

  it.each<[string, Partial<CardRead>]>([
    ["net pay a cent high", { net_pay_cents: 117_751 }],
    ["net pay a cent low", { net_pay_cents: 117_749 }],
    ["net pay in dollars", { net_pay_cents: 1_177 }],
    ["net pay missing", { net_pay_cents: null }],
    ["earned off", { earned_cents: 141_201 }],
    ["taken out off", { taken_out_cents: 23_400 }],
    ["loads off", { loads: 2 }],
    ["miles missing", { miles: null }],
    ["change sign flipped", { change_cents: -7_750 }],
    ["change missing", { change_cents: null }],
    ["an amount the card does not print", { other_amounts_cents: [11_200, 5] }],
    ["another digit", { any_other_digits: true }],
  ])("calls %s a number mismatch", (_name, change) => {
    expect(compareCard(spec, { ...good, ...change })).toBe("number_mismatch");
  });

  it.each<[string, Partial<CardRead>]>([
    ["another name", { first_name: "Anna" }],
    ["a name that only contains it", { first_name: "Ana Maria" }],
    ["no name", { first_name: null }],
    ["another week", { week_text: "Week of Oct 12 to Oct 18, 2026" }],
    ["part of the week", { week_text: "Oct 19 to Oct 25, 2026" }],
    ["no week", { week_text: null }],
  ])("calls %s a text mismatch", (_name, change) => {
    expect(compareCard(spec, { ...good, ...change })).toBe("text_mismatch");
  });

  it("checks the numbers before the words", () => {
    expect(compareCard(spec, { ...good, first_name: "Bob", net_pay_cents: 1 })).toBe("number_mismatch");
  });

  it("reads letter case, spacing and composed accents as the same words", () => {
    expect(normText("  ana   maría ")).toBe(normText("ANA MARÍA"));
    expect(compareCard(spec, { ...good, first_name: " ana ", week_text: "WEEK OF OCT 19  TO OCT 25, 2026" })).toBeNull();
  });

  it("wants a printed miles figure null when the card prints none, and a first week's change null", () => {
    // A first week prints no change, so its amount is not among the card's amounts either.
    const noMiles = { ...spec, miles: null, changeCents: null, amountsCents: spec.amountsCents.filter((a) => a !== 7_750) };
    expect(compareCard(noMiles, { ...good, miles: null, change_cents: null })).toBeNull();
    expect(compareCard(noMiles, { ...good, miles: 1_050, change_cents: null })).toBe("number_mismatch");
    expect(compareCard(noMiles, { ...good, miles: null, change_cents: 0 })).toBe("number_mismatch");
  });
});

describe("checkRequest", () => {
  it("sends the picture and the fixed prompt only, under the card's cost cap", () => {
    const png = new Uint8Array([1, 2, 3]);
    const request = checkRequest(png, "trace-1");
    expect(request).toMatchObject({
      purpose: "pay_card_check",
      reasoningEffort: "low",
      maxOutputTokens: 400,
      maxCostCents: flags.payCardLimits.checkMaxCostCents,
      traceId: "trace-1",
      format: { name: "pay_card_read", strict: true },
    });
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const user = request.messages[1];
    expect(user.role === "user" ? user.attachments : null).toEqual([{ kind: "image", mime: "image/png", bytes: png }]);
    expect(user.content).toBe("Read this pay card.");
  });
});

describe("checkPayCard switches", () => {
  const saved = { cards: flags.payCardsEnabled, ai: flags.aiEnabled };
  afterEach(() => {
    flags.payCardsEnabled = saved.cards;
    flags.aiEnabled = saved.ai;
  });

  // A database that fails any use: the refusals below must come before it.
  const db = {
    withTenant: vi.fn(() => {
      throw new Error("no database here");
    }),
  };
  const session = { sub: "s", email: "", tenantId: "t" };
  const input = { settlementId: "x", traceId: "y", png: new Uint8Array(24) };

  it("refuses while pay cards or the models are off, and a picture of the wrong size, with no database use", async () => {
    flags.payCardsEnabled = false;
    flags.aiEnabled = true;
    expect(await checkPayCard(session, input, { db })).toEqual({ ok: false, category: "cards_off" });
    flags.payCardsEnabled = true;
    flags.aiEnabled = false;
    expect(await checkPayCard(session, input, { db })).toEqual({ ok: false, category: "ai_off" });
    flags.aiEnabled = true;
    expect(await checkPayCard(session, input, { db })).toEqual({ ok: false, category: "bad_image" });
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it("ships dark", () => {
    expect(saved.cards).toBe(false);
  });
});
