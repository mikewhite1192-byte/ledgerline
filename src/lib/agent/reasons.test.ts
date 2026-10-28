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

// The rules engine's money code reasons, as rules-engine/money-codes.ts names them (written out
// for the same reason; that module's test checks MONEY_CODE_REASONS against this list).
const MONEY_CODE_REASON_LIST = [
  "load_in_transit",
  "load_delivered_recently",
  "receipt_total_matches",
  "voice_amount",
  "driver_armed",
];

// Every reason a paystub can be parked, as settlements/reconcile.ts names them (written out for
// the same reason; settlements/reconcile.test.ts checks the module against these sentences).
const PARK_REASON_LIST = [
  "line_amount_changed",
  "line_missing",
  "line_added",
  "line_sources_changed",
  "total_changed",
  "source_missing",
  "source_settled_elsewhere",
  "source_changed",
  "advance_overrecovered",
  "schedule_inactive",
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
      "insurance_exempt",
      "net_below_zero",
      ...PARK_REASON_LIST,
      ...MONEY_CODE_REASON_LIST,
    ];
    for (const c of all) expect(REASON_SENTENCE_CATEGORIES).toContain(c);
  });

  it("words the pay run's notes and every reason a paystub can be parked", () => {
    expect(reasonSentence("insurance_exempt")).toBe(
      "The driver carries their own insurance, so no daily charge applies.",
    );
    expect(reasonSentence("net_below_zero")).toBe(
      "Deductions were more than pay this week; net is $0 and the rest carries to next week.",
    );
    for (const c of PARK_REASON_LIST) expect(reasonSentence(c)).not.toBe("A rule check found this.");
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
