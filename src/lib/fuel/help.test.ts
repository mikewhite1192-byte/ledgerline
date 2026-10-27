import { describe, expect, it } from "vitest";
import { REASON_SENTENCE_CATEGORIES } from "../agent/reasons";
import { FUEL_CATEGORY_OF, type FuelCheckName, type NoSuggestionReason } from "../rules-engine/fuel";
import {
  compareLine,
  DISMISS_CATEGORIES,
  DISMISS_WORDS,
  FUEL_LABELS,
  FUEL_PAGE_WORDS,
  fuelHelp,
  fuelSentence,
  gallonsText,
  noSuggestionLine,
  proposeLabel,
  runLine,
  stateList,
  type SentenceInput,
} from "./help";

// The fuel page's words: every check, reason and state has a fixed sentence, numbers come out
// exact, and nothing a person reads carries an internal word, an id or an em dash.

const CHECKS: FuelCheckName[] = ["fuel_off_route", "fuel_over_tank", "fuel_while_parked", "fuel_duplicate"];
const REASONS: NoSuggestionReason[] = [
  "driver_paid",
  "already_deducted",
  "over_tank",
  "card_double_charge",
  "not_paid_back",
  "over_limit",
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const INTERNAL = /proposal|tenant|ledger|executor|\bkind\b|fuel_|_id\b|\u2014/i;

function base(check: FuelCheckName): SentenceInput {
  return {
    check,
    driver: "Dana Whitfield",
    purchasedOn: "2026-10-29",
    state: "TN",
    gallonsMilli: 286_400,
    tankGallons: 200,
    amountCents: 36_575,
    paidWith: "company_card",
    loadNumber: "BR-L10311",
    loadStates: ["GA", "NC"],
    minutesApart: 6,
  };
}

function everyLine(): string[] {
  const lines: string[] = [
    ...Object.values(FUEL_LABELS),
    ...Object.values(DISMISS_WORDS),
    ...Object.values(FUEL_PAGE_WORDS),
    runLine(464, 4),
    proposeLabel(-36_575),
  ];
  for (const c of CHECKS) lines.push(fuelHelp(c, 200, 286_400), fuelSentence(base(c)));
  for (const r of REASONS) lines.push(noSuggestionLine(r, 12_345), noSuggestionLine(r, null));
  for (const category of ["no_photos", "budget", "timeout", "unreadable", null]) {
    lines.push(compareLine({ verdict: "unknown", confidence: null, category }));
  }
  lines.push(compareLine({ verdict: "same", confidence: "high", category: null }));
  lines.push(compareLine({ verdict: null, confidence: null, category: null }));
  return lines;
}

describe("fuel page words", () => {
  it("has a label, help and sentence for every check and a line for every no-suggestion reason", () => {
    for (const c of CHECKS) {
      expect(FUEL_LABELS[c]).toBeTruthy();
      expect(fuelHelp(c, 200, 286_400)).toBeTruthy();
      expect(fuelSentence(base(c))).toMatch(/\.$/);
    }
    for (const r of REASONS) expect(noSuggestionLine(r, null)).toMatch(/^(No pay change suggested|Above the correction limit)/);
    for (const d of DISMISS_CATEGORIES) expect(DISMISS_WORDS[d]).toBeTruthy();
  });

  it("gives every check's reason category a card sentence", () => {
    for (const c of CHECKS) expect(REASON_SENTENCE_CATEGORIES).toContain(FUEL_CATEGORY_OF[c]);
  });

  it("never shows an id, an internal word or an em dash", () => {
    for (const line of everyLine()) {
      expect(line).not.toMatch(UUID);
      expect(line).not.toMatch(INTERNAL);
    }
  });

  it("writes the design's sentences with every number", () => {
    expect(fuelSentence(base("fuel_off_route"))).toBe(
      "Dana Whitfield bought 286.4 gallons in Tennessee on Oct 29, but load BR-L10311 ran through Georgia and North Carolina.",
    );
    expect(fuelSentence(base("fuel_over_tank"))).toBe(
      "Dana Whitfield bought 286.4 gallons in Tennessee on Oct 29, but the truck's tank holds 200 gallons: 86.4 gallons more than fit.",
    );
    expect(fuelSentence(base("fuel_duplicate"))).toBe(
      "Dana Whitfield turned in the same fill-up twice on Oct 29: 286.4 gallons for $365.75 in Tennessee, 6 minutes apart.",
    );
    expect(fuelHelp("fuel_over_tank", 200, 286_400)).toBe("This truck's tank holds 200 gallons; this fill-up was 286.4");
    expect(proposeLabel(-36_575)).toBe("Propose a pay correction of $365.75");
    expect(noSuggestionLine("over_tank", 32_100)).toBe(
      "No pay change suggested: the gallons over the tank cost $321.00. Check them with the driver.",
    );
  });

  it("counts fill-ups in plain words", () => {
    expect(runLine(464, 4)).toBe("Checked 464 fill-ups, 4 need you.");
    expect(runLine(1, 1)).toBe("Checked 1 fill-up, 1 needs you.");
    expect(runLine(0, 0)).toBe("Checked 0 fill-ups, 0 need you.");
  });

  it("writes gallons as on a receipt, with integer math only", () => {
    expect(gallonsText(286_400)).toBe("286.4");
    expect(gallonsText(95_000)).toBe("95.0");
    expect(gallonsText(84_250)).toBe("84.25");
    expect(gallonsText(1_000_001)).toBe("1,000.001");
    expect(() => gallonsText(1.5)).toThrow(RangeError);
    expect(() => gallonsText(-1)).toThrow(RangeError);
  });

  it("lists states by name", () => {
    expect(stateList([])).toBe("");
    expect(stateList(["NC"])).toBe("North Carolina");
    expect(stateList(["NC", "GA"])).toBe("North Carolina and Georgia");
    expect(stateList(["NC", "SC", "GA"])).toBe("North Carolina, South Carolina and Georgia");
    expect(stateList(["ZZ"])).toBe("ZZ");
  });

  it("says what the photo compare found, and what to do when it could not", () => {
    expect(compareLine({ verdict: "same", confidence: "high", category: null })).toBe(
      "The two photos show the same receipt (high confidence).",
    );
    expect(compareLine({ verdict: "different", confidence: "low", category: null })).toBe(
      "The two photos show different receipts (low confidence).",
    );
    expect(compareLine({ verdict: "unknown", confidence: null, category: "no_photos" })).toMatch(/Upload the receipt photos/);
    expect(compareLine({ verdict: "same", confidence: "sure", category: null })).toBe("The photos have not been compared yet.");
  });
});
