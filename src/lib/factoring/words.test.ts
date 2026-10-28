import { describe, expect, it } from "vitest";
import { FACTORING_REFUSALS } from "../rules-engine/factoring";
import { EMPTY_PACKET } from "./packet";
import {
  CHECK_NOTICE,
  CHECK_RESULT,
  checkResultSentence,
  dayOf,
  FACTORING_APPROVE_NOTICE,
  FACTORING_REFUSAL_SENTENCES,
  factoringSentence,
  packetLine,
  receiveLine,
  requestStatusWords,
  TEST_MODE_HELP,
} from "./words";

// Factoring's fixed words: every category has its own sentence, an unknown one reads in plain
// words, and no sentence carries a code, a raw date or a dash.

const ALL = [
  ...Object.values(FACTORING_APPROVE_NOTICE),
  ...Object.values(FACTORING_REFUSAL_SENTENCES),
  ...Object.values(CHECK_NOTICE),
  ...Object.values(CHECK_RESULT),
  TEST_MODE_HELP,
];

describe("factoring words", () => {
  it("has a sentence for every reason the rules refuse an invoice", () => {
    expect(Object.keys(FACTORING_REFUSAL_SENTENCES).sort()).toEqual([...FACTORING_REFUSALS].sort());
    for (const r of FACTORING_REFUSALS) expect(factoringSentence(r)).toBe(FACTORING_REFUSAL_SENTENCES[r]);
  });

  it("says an approval's refusal, a check's refusal, and an unknown code in plain words", () => {
    expect(factoringSentence("packet_incomplete")).toMatch(/proof of delivery/);
    expect(factoringSentence("factoring_pending")).toMatch(/Check pending/);
    expect(factoringSentence("not_found")).toBe(CHECK_NOTICE.not_found);
    expect(factoringSentence("unavailable")).toMatch(/Nothing was sent/);
    expect(factoringSentence("something_new")).toBe("Something new.");
    // A name on every object is still only a code here, never the object's own function.
    expect(factoringSentence("toString")).toBe("Tostring.");
  });

  it("writes every sentence without a code, a raw date, an em dash or a model's name", () => {
    for (const s of ALL) {
      expect(s, s).not.toMatch(/_|—|\d{4}-\d{2}-\d{2}/);
      expect(s, s).toMatch(/[.)]$/);
    }
  });

  it("says each status the way the pages show it", () => {
    expect(requestStatusWords("funded")).toBe("Funded");
    expect(requestStatusWords("submitted")).toBe("Sent, not confirmed yet");
    expect(requestStatusWords("unknown")).toBe("Sent, not confirmed yet");
    expect(requestStatusWords("partly_funded")).toBe("Partly funded");
    expect(requestStatusWords("declined")).toBe("Declined");
    expect(requestStatusWords("failed")).toBe("Did not go through");
    expect(requestStatusWords("on_hold")).toBe("On hold");
  });

  it("names the papers on file and the ones missing, in one line", () => {
    expect(packetLine(EMPTY_PACKET)).toBe("Invoice on file; rate confirmation, bill of lading, POD missing");
    expect(
      packetLine({ ...EMPTY_PACKET, rateConfirmation: { onFile: true, documentId: "5e7c2a10-4b3d-4f6e-8a9b-000000000001" } }),
    ).toBe("Invoice, rate confirmation on file; bill of lading, POD missing");
    expect(
      packetLine({
        invoice: true,
        rateConfirmation: { onFile: true, documentId: null },
        billOfLading: { onFile: true, documentId: null },
        pod: { onFile: true, portalRunId: null },
      }),
    ).toBe("Invoice, rate confirmation, bill of lading, POD on file");
  });

  it("says the money in one sentence", () => {
    expect(receiveLine("$5,611.50", "$645.00", "$193.50")).toBe(
      "You receive $5,611.50 now, $645.00 held back until the customer pays, fee $193.50.",
    );
  });

  it("says what a Check pending press found, the strongest news first", () => {
    const none = { confirmed: 0, failed: 0, tooNew: 0, stillWaiting: 0, stillUnknown: 0 };
    expect(checkResultSentence({ ...none, confirmed: 1, failed: 1 })).toBe(CHECK_RESULT.confirmed);
    expect(checkResultSentence({ ...none, failed: 1, tooNew: 1 })).toBe(CHECK_RESULT.declined);
    expect(checkResultSentence({ ...none, tooNew: 1, stillWaiting: 1 })).toBe(CHECK_RESULT.tooNew);
    expect(checkResultSentence({ ...none, stillWaiting: 1 })).toBe(CHECK_RESULT.waiting);
    expect(checkResultSentence({ ...none, stillUnknown: 1 })).toBe(CHECK_RESULT.waiting);
    expect(checkResultSentence(none)).toBe(CHECK_RESULT.nothing);
  });

  it("names the Test mode convention the simulated partner follows", () => {
    expect(TEST_MODE_HELP).toMatch(/99 cents is declined/);
    expect(TEST_MODE_HELP).toMatch(/98 cents is slow/);
  });

  it("gives the day an instant falls on in the carrier's zone, and never the stored text", () => {
    // 01:30 UTC on Nov 3 is still Nov 2 in Eastern time.
    expect(dayOf("2026-11-03T01:30:00.000Z", "America/New_York")).toBe("Nov 2, 2026");
    expect(dayOf("2026-11-03T01:30:00.000Z", "UTC")).toBe("Nov 3, 2026");
    expect(dayOf("not a time", "America/New_York")).toBe("Unknown day");
  });
});
