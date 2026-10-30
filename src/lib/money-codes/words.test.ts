import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { ADVANCE_APPROVE_NOTICE } from "../advances/reasons";
import { MONEY_CODE_REFUSALS, MONEY_CODE_STATUSES } from "../rules-engine/money-codes";
import { issueGate, moneyCodesOn } from "./switches";
import {
  actionSentence,
  checkSentence,
  expiresInWords,
  MONEY_CODE_APPROVE_NOTICE,
  MONEY_CODE_PAGE_NOTICE,
  moneyCodeSentence,
  moneyCodeStatusWord,
  PURPOSE_CHOICES,
  REFUSAL_SENTENCES,
  requestSentence,
} from "./words";

// The proposal gate's own categories, as the chat card words them (turn-view's APPROVE_NOTICE).
const GATE_CATEGORIES = [
  "not_executable",
  "already_decided",
  "expired",
  "role",
  "auditor_required",
  "not_auditable",
  "override_required",
  "stale",
  "invoice_posted",
  "bad_request",
  "needs_confirm",
  "not_found",
];

const FALLBACK = moneyCodeSentence(undefined);
const saved = structuredClone(flags.moneyCodes);
const savedPayouts = flags.payoutsEnabled;

afterEach(() => {
  flags.moneyCodes = structuredClone(saved);
  flags.payoutsEnabled = savedPayouts;
});

describe("money code words", () => {
  it("words every refusal and every issue gate outcome, and nothing else past the fallback", () => {
    for (const r of MONEY_CODE_REFUSALS) expect(moneyCodeSentence(r), r).toBe(REFUSAL_SENTENCES[r]);
    for (const c of ["codes_off", "codes_payouts_off", "codes_not_armed", "codes_before_start"]) {
      expect(moneyCodeSentence(c), c).not.toBe(FALLBACK);
    }
    for (const c of ["code_exists", "code_declined", "code_failed", "code_pending", "code_unavailable"]) {
      expect(moneyCodeSentence(c), c).not.toBe(FALLBACK);
    }
    expect(moneyCodeSentence("check_unavailable")).not.toBe(FALLBACK);
    expect(moneyCodeSentence("code_ref_collision")).not.toBe(FALLBACK);
    expect(moneyCodeSentence("toString")).toBe(FALLBACK);
    expect(moneyCodeSentence("Provider said: card 4111 declined")).toBe(FALLBACK);
  });

  it("shares no word with the advance card or the proposal gate, so the chat card map has one sentence per word", () => {
    for (const k of Object.keys(MONEY_CODE_APPROVE_NOTICE)) {
      expect(Object.hasOwn(ADVANCE_APPROVE_NOTICE, k), k).toBe(false);
      expect(GATE_CATEGORIES, k).not.toContain(k);
    }
    // The two left out are the advance's, with the same meaning.
    expect(ADVANCE_APPROVE_NOTICE.load_not_drivers).toBeTruthy();
    expect(ADVANCE_APPROVE_NOTICE.driver_not_armed).toBeTruthy();
  });

  it("words the request form's outcomes and every status", () => {
    for (const c of ["created", "duplicate", "live_exists", "already_decided", "bad_request", "codes_off"]) {
      expect(requestSentence(c), c).not.toBe(FALLBACK);
    }
    expect(requestSentence("receipt_total_differs")).toBe(REFUSAL_SENTENCES.receipt_total_differs);
    for (const s of MONEY_CODE_STATUSES) expect(moneyCodeStatusWord(s), s).not.toBe("Not known");
    expect(moneyCodeStatusWord("constructor")).toBe("Not known");
  });
});

describe("money code switches", () => {
  const on = () => {
    flags.moneyCodes = { enabled: true, armed: true, capCents: 50_000, perDriverPerDay: 2, startDate: "2026-10-28" };
    flags.payoutsEnabled = true;
  };

  it("is off by default and closed at every step of the gate", () => {
    expect(moneyCodesOn()).toBe(false);
    expect(issueGate(15_000, "2026-10-28")).toBe("codes_off");
    on();
    expect(moneyCodesOn()).toBe(true);
    expect(issueGate(15_000, "2026-10-28")).toBeNull();
    flags.payoutsEnabled = false;
    expect(issueGate(15_000, "2026-10-28")).toBe("codes_payouts_off");
    flags.payoutsEnabled = true;
    flags.moneyCodes.armed = false;
    expect(issueGate(15_000, "2026-10-28")).toBe("codes_not_armed");
  });

  it("allows exactly the cap, refuses a cent over, and opens on the start date", () => {
    on();
    expect(issueGate(50_000, "2026-10-28")).toBeNull();
    expect(issueGate(50_001, "2026-10-28")).toBe("over_code_cap");
    expect(issueGate(1.5, "2026-10-28")).toBe("over_code_cap");
    expect(issueGate(15_000, "2026-10-27")).toBe("codes_before_start");
    flags.moneyCodes.startDate = "2026-02-30";
    expect(issueGate(15_000, "2026-10-28")).toBe("codes_before_start");
  });
});

describe("the page's words", () => {
  it("gives the page's cards every money code sentence, the two shared ones included", () => {
    for (const r of MONEY_CODE_REFUSALS) expect(MONEY_CODE_PAGE_NOTICE[r], r).toBe(REFUSAL_SENTENCES[r]);
    for (const k of Object.keys(MONEY_CODE_APPROVE_NOTICE)) expect(MONEY_CODE_PAGE_NOTICE[k], k).toBe(MONEY_CODE_APPROVE_NOTICE[k]);
  });

  it("offers every purpose once, in words", () => {
    expect(PURPOSE_CHOICES.map((p) => p.value)).toEqual(["lumper", "repair", "other"]);
    expect(PURPOSE_CHOICES.map((p) => p.label)).toEqual(["Lumper", "Repair", "Other"]);
  });

  it("words each button refusal, and falls back to the money code sentences", () => {
    expect(actionSentence("code_expired")).toBe("This code expired. Request a new one if the driver still needs it.");
    expect(actionSentence("not_issued")).toBe("The code is not issued yet, so there is nothing to show.");
    expect(actionSentence("code_unavailable")).toBe(moneyCodeSentence("code_unavailable"));
    expect(actionSentence("toString")).toBe(moneyCodeSentence(null));
    expect(actionSentence(undefined)).toBe(moneyCodeSentence(null));
  });

  it("says what Check pending settled, and never says nothing was waiting while something is", () => {
    const s = (checked: number, confirmed: number, failed: number) => ({ checked, confirmed, failed, stillUnknown: checked - confirmed - failed });
    expect(checkSentence(s(1, 1, 0), 0, 0)).toBe("Confirmed. The code is issued and its paystub lines are added.");
    expect(checkSentence(s(1, 0, 1), 0, 0)).toBe("The card provider says no code was issued. Nothing was charged to the driver.");
    expect(checkSentence(s(1, 0, 0), 0, 0)).toBe("Still not confirmed. Nothing was changed. Check again later.");
    expect(checkSentence(s(0, 0, 0), 1, 1)).toBe("The code was asked for less than a minute ago, too soon to check. Check again in a minute.");
    expect(checkSentence(s(0, 0, 0), 0, 1)).toBe("The code is still waiting on the card provider. Nothing was changed. Check again later.");
    expect(checkSentence(undefined, 0, 0)).toBe("Nothing was waiting to be checked.");
  });

  it("counts down to the expiry in hours and minutes, on a fixed clock", () => {
    const now = new Date("2026-10-28T15:00:00.000Z");
    expect(expiresInWords("2026-10-29T15:00:00.000Z", now)).toBe("24 h 00 min");
    expect(expiresInWords("2026-10-28T16:05:30.000Z", now)).toBe("1 h 06 min");
    expect(expiresInWords("2026-10-28T15:00:01.000Z", now)).toBe("1 min");
    expect(expiresInWords("2026-10-28T15:00:00.000Z", now)).toBe("Expired");
    expect(expiresInWords("not a time", now)).toBe("Not known");
  });
});
