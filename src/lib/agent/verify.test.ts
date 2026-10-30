import { describe, expect, it } from "vitest";
import { AUDIT_LINES } from "../../../e2e/audit-line";
import { ANSWER_PILL, ANSWER_REASONS, VERIFY_LINES, answerVerification, verification } from "./verify";
import type { ProposalView } from "./view";

type Checked = Pick<ProposalView, "engineCheck" | "engineHeld" | "auditorVerdict" | "auditorConcerns">;

const at = (over: Partial<Checked>): Checked => ({
  engineCheck: null,
  engineHeld: false,
  auditorVerdict: null,
  auditorConcerns: [],
  ...over,
});

describe("verification", () => {
  it("is Verified only when the pay rules matched and the second check passed", () => {
    expect(verification(at({ engineCheck: "matched", auditorVerdict: "pass" }), true)).toEqual({
      state: "verified",
      line: VERIFY_LINES.verified,
      held: false,
    });
    for (const verdict of [null, "concerns", "block", "unknown"]) {
      expect(verification(at({ engineCheck: "matched", auditorVerdict: verdict }), true)?.state, String(verdict)).toBe("unverified");
    }
    for (const check of [null, "unavailable", "mismatch"] as const) {
      expect(verification(at({ engineCheck: check, auditorVerdict: "pass" }), true)?.state, String(check)).not.toBe("verified");
    }
  });

  // The six states of the label, each with its reason.
  it.each([
    ["neither ran", at({}), true, "unverified", VERIFY_LINES.notChecked],
    ["only the second check ran", at({ auditorVerdict: "pass" }), true, "unverified", VERIFY_LINES.rulesNotChecked],
    ["matched, the second check still to come", at({ engineCheck: "matched" }), true, "unverified", VERIFY_LINES.pending],
    ["matched, the second check off", at({ engineCheck: "matched" }), false, "unverified", VERIFY_LINES.off],
    ["matched, concerns", at({ engineCheck: "matched", auditorVerdict: "concerns" }), true, "unverified", VERIFY_LINES.concerns],
    ["matched, block", at({ engineCheck: "matched", auditorVerdict: "block" }), true, "unverified", VERIFY_LINES.block],
    ["matched, budget", at({ engineCheck: "matched", auditorVerdict: "unknown", auditorConcerns: ["budget"] }), true, "unverified", VERIFY_LINES.budget],
    ["matched, could not run", at({ engineCheck: "matched", auditorVerdict: "unknown" }), true, "unverified", VERIFY_LINES.unknown],
    ["could not be recomputed", at({ engineCheck: "unavailable", auditorVerdict: "pass" }), true, "unverified", VERIFY_LINES.unavailable],
    ["mismatch, held", at({ engineCheck: "mismatch", engineHeld: true, auditorVerdict: "pass" }), true, "mismatch", VERIFY_LINES.held],
    ["mismatch, not held", at({ engineCheck: "mismatch", engineHeld: false }), true, "mismatch", VERIFY_LINES.mismatch],
    ["verified", at({ engineCheck: "matched", auditorVerdict: "pass" }), false, "verified", VERIFY_LINES.verified],
  ] as const)("%s", (_name, p, auditorOn, state, line) => {
    expect(verification(p, auditorOn)).toEqual({ state, line, held: state === "mismatch" && p.engineHeld === true });
  });

  it("says nothing when the page did not read the engine check", () => {
    expect(verification({ auditorVerdict: "pass", auditorConcerns: [] }, true)).toBeNull();
  });

  it("holds only a mismatch", () => {
    expect(verification(at({ engineCheck: "matched", engineHeld: true }), true)?.held).toBe(false);
    expect(verification(at({ engineCheck: "mismatch", engineHeld: true }), true)?.held).toBe(true);
  });

  it("never reads as a second check line, so the demo path's whole-line match is unchanged", () => {
    for (const line of [...Object.values(VERIFY_LINES), ANSWER_PILL.verified, ANSWER_PILL.unverified, ...Object.values(ANSWER_REASONS)]) {
      expect(AUDIT_LINES, line).not.toContain(line);
    }
  });
});

const pass = at({ engineCheck: "matched", auditorVerdict: "pass" }) as ProposalView;
const pending = at({ engineCheck: "matched" }) as ProposalView;

describe("answerVerification", () => {
  it("is Verified for a plain answer with no withheld figure, with its own help", () => {
    expect(answerVerification({ status: "done", proposals: [], withheldFigures: 0 }, true)).toEqual({
      state: "verified",
      pill: ANSWER_PILL.verified,
      reason: null,
      help: "verified-answer",
    });
  });

  it("is Verified when every card is", () => {
    expect(answerVerification({ status: "partial", proposals: [pass, pass], withheldFigures: 0 }, true)).toMatchObject({
      state: "verified",
      help: "verified",
    });
  });

  it("is Unverified, with the reason, on a withheld figure, an unknown count or a card not yet verified", () => {
    expect(answerVerification({ status: "done", proposals: [], withheldFigures: 2 }, true)).toMatchObject({
      state: "unverified",
      reason: ANSWER_REASONS.withheld,
    });
    expect(answerVerification({ status: "done", proposals: [pass], withheldFigures: null }, true)).toMatchObject({
      state: "unverified",
      reason: ANSWER_REASONS.unknown,
    });
    expect(answerVerification({ status: "done", proposals: [pass, pending], withheldFigures: 0 }, true)).toMatchObject({
      state: "unverified",
      reason: ANSWER_REASONS.cards,
    });
    // A card whose check the page did not read is not Verified either.
    const unread = { ...pass, engineCheck: undefined } as ProposalView;
    expect(answerVerification({ status: "done", proposals: [unread], withheldFigures: 0 }, true)?.state).toBe("unverified");
  });

  it("has no header on a running or failed answer, or one read without its counts", () => {
    expect(answerVerification({ status: "running", proposals: [], withheldFigures: 0 }, true)).toBeNull();
    expect(answerVerification({ status: "failed", proposals: [], withheldFigures: 0 }, true)).toBeNull();
    expect(answerVerification({ status: "done", proposals: [] }, true)).toBeNull();
  });
});
