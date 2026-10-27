import { describe, expect, it } from "vitest";
import { ADVANCE_REASON_CATEGORIES } from "./gateway/tools/propose/propose-advance";
import { INVOICE_FIX_REASON_CATEGORIES } from "./gateway/tools/propose/propose-invoice-fix";
import { PAY_CORRECTION_REASON_CATEGORIES } from "./gateway/tools/propose/propose-pay-correction";
import { MODEL_SCREEN_CATEGORIES } from "./gateway/screen-format";
import { flagWords, reasonSentence, REASON_SENTENCE_CATEGORIES } from "./reasons";

// The rules engine's advance refusals, as advances.ts names them (agent code cannot import the
// engine, so the list is written out; a new refusal shows the generic line until added here).
const ENGINE_ADVANCE_REASONS = [
  "driver_inactive",
  "below_minimum",
  "no_unpaid_earnings",
  "over_driver_limit",
  "exceeds_earned_share",
  "possible_duplicate",
];

describe("reason sentences", () => {
  it("has a fixed sentence for every category a propose tool or the engine can give", () => {
    const all = [
      ...ADVANCE_REASON_CATEGORIES,
      ...PAY_CORRECTION_REASON_CATEGORIES,
      ...INVOICE_FIX_REASON_CATEGORIES,
      ...ENGINE_ADVANCE_REASONS,
      "capped_to_eligible",
      "engine_total",
      "payment_on_wrong_invoice",
      "missing_rate",
      "rule_change_sized_by_engine",
      "escrow_on_driver_schedules",
    ];
    for (const c of all) expect(REASON_SENTENCE_CATEGORIES).toContain(c);
  });

  it("shows the generic line for a category it does not know, even a prototype name", () => {
    expect(reasonSentence("constructor")).toBe("A rule check found this.");
    expect(reasonSentence("made_up")).toBe("A rule check found this.");
  });

  it("names every screening category in words", () => {
    for (const c of MODEL_SCREEN_CATEGORIES) expect(flagWords([c])).not.toBe("a screening flag");
    expect(flagWords(["instruction_to_agent", "instruction_to_agent", "authority_claim"])).toBe(
      "instructions to the assistant, a claim of authority",
    );
    expect(flagWords([])).toBe("a screening flag");
    expect(flagWords(["toString"])).toBe("a screening flag");
  });
});
