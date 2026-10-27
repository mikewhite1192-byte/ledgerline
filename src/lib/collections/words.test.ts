import { describe, expect, it } from "vitest";
import {
  approvedWords,
  DECIDE_ERROR_WORDS,
  DRAFT_ERROR_WORDS,
  draftedWords,
  REMINDER_STATUS_WORDS,
  refusalWords,
  stillWaitingWords,
  TONE_HELP,
  TONE_WORDS,
} from "./words";

// The page's words: plain, no status codes, categories or model names, money and times as a
// person reads them.

const CODE = /_|\b(?:over_cap|number_mismatch|banned_phrase|muse|model_call)\b/i;

describe("collections words", () => {
  it("names every status and tone in plain words", () => {
    for (const [status, words] of Object.entries(REMINDER_STATUS_WORDS)) {
      expect(words, status).not.toMatch(CODE);
      expect(words.length, status).toBeGreaterThan(0);
    }
    expect(REMINDER_STATUS_WORDS.drafted).toBe("Waiting for you");
    expect(TONE_WORDS).toEqual({ friendly: "Friendly", direct: "Direct", firm: "Firm" });
    expect(TONE_HELP).toBe("Chosen from how this customer has paid in the last 6 months");
  });

  it("says why a reminder was not kept without its category, and that nothing was sent", () => {
    for (const category of ["number_mismatch", "banned_phrase", "subject", "format", "language", "timeout", "interrupted", null, "unheard_of"]) {
      const words = refusalWords(category);
      expect(words, String(category)).toMatch(/^Not kept, and nothing was sent: /);
      expect(words, String(category)).not.toMatch(CODE);
    }
    expect(refusalWords("banned_phrase")).toContain("fees, interest or legal action");
  });

  it("says Test mode until an email really went, with the send time in the carrier's zone", () => {
    expect(approvedWords("logged", null, "America/New_York")).toBe("Approved, not sent (Test mode)");
    expect(approvedWords(null, null, "America/New_York")).toBe("Approved, not sent (Test mode)");
    expect(approvedWords("email", "2026-10-28T19:12:00.000Z", "America/New_York")).toBe("Sent Oct 28, 2026, 3:12 PM EDT");
    expect(approvedWords("email", null, "America/New_York")).toBe("Email attempted, not confirmed as sent");
  });

  it("counts a run in the design's words", () => {
    expect(draftedWords(3, 0)).toBe("Drafted 3 reminders. 0 needed a second look.");
    expect(draftedWords(1, 1)).toBe("Drafted 1 reminder. 1 needed a second look.");
    expect(stillWaitingWords(0, null)).toBeNull();
    expect(stillWaitingWords(1, null)).toBe("1 invoice still needs a reminder. Press Draft reminders again.");
    expect(stillWaitingWords(14, "cap")).toBe(
      "14 invoices still need a reminder. This run reached its spending limit. Press Draft reminders again.",
    );
    expect(stillWaitingWords(2, "model")).toContain("Try again in a moment.");
  });

  // The app's internal words (docs word list): none reaches this page, its cards or the routes'
  // messages. "Did not pass" is the plain word for a failed check, so "pass" itself is allowed.
  it("uses none of the app's internal words", () => {
    const INTERNAL =
      /\b(?:proposals?|tenants?|ledger|executor|execut\w*|idempoten\w*|payload|kind|rules engine|engine total|auditor|verdict|gateway|allowed|effort|read-back|reserved|outcome unknown|in progress|cut short|cap|hourly allowance|upstream|trace|call log|retired|aging|accessorials?|lane|unapplied|muse|spark|sam|utc)\b|[A-Za-z]+\/[A-Za-z_]+|\d{4}-\d{2}-\d{2}/i;
    const categories = [
      "number_mismatch", "line_mismatch", "subject", "banned_phrase", "language", "format", "incomplete", "interrupted",
      "disabled", "not_configured", "cap", "too_expensive", "rate_limited", "unavailable", "timeout", "network", null, "unheard_of",
    ];
    const words = [
      ...Object.values(REMINDER_STATUS_WORDS),
      ...Object.values(TONE_WORDS),
      TONE_HELP,
      ...categories.map(refusalWords),
      approvedWords("logged", null, "America/New_York"),
      approvedWords("email", null, "America/New_York"),
      draftedWords(3, 1),
      stillWaitingWords(2, null) ?? "",
      stillWaitingWords(2, "cap") ?? "",
      stillWaitingWords(2, "model") ?? "",
      ...Object.values(DRAFT_ERROR_WORDS),
      ...Object.values(DECIDE_ERROR_WORDS),
    ];
    for (const w of words) expect(w).not.toMatch(INTERNAL);
    expect(refusalWords("incomplete")).toBe("Not kept, and nothing was sent: it stopped early.");
    expect(refusalWords("cap")).toBe("Not kept, and nothing was sent: the model budget was used up.");
  });
});
