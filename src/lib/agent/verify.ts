import type { TermId } from "../format/terms";
import type { ProposalView, TurnView } from "./view";

// One label for a card and for an answer, computed when it is read, never stored (design 3.6).
// Verified only when both checks agree: the rules engine's own recompute matched the card to the
// cent (engine_check, 0045) and the second check passed. Anything else is Unverified, with the
// reason; a mismatch is its own state, held for a person while verifyEngineMismatchBlocks is on.
// Every line is fixed text. None of them equals a second-check line (e2e/audit-line.ts), so the
// demo path's whole-line match is unchanged.

export type VerificationState = "verified" | "unverified" | "mismatch";

export type Verification = { state: VerificationState; line: string; held: boolean };

export const VERIFY_PILL: Readonly<Record<VerificationState, string>> = {
  verified: "Verified",
  unverified: "Unverified",
  mismatch: "Unverified",
};

export const VERIFY_LINES = {
  verified: "Your pay rules recomputed it and a second check agreed.",
  held: "Numbers did not match your pay rules; held for a person.",
  mismatch: "Numbers did not match your pay rules.",
  unavailable: "Could not be recomputed from your records.",
  notChecked: "Not checked yet",
  rulesNotChecked: "Pay rules not checked yet",
  pending: "Pay rules matched. Second check pending",
  off: "Pay rules matched. Second check is off",
  concerns: "Pay rules matched. Second check has concerns",
  block: "Pay rules matched. Second check did not pass",
  budget: "Pay rules matched. Second check skipped: demo budget reached",
  unknown: "Pay rules matched. Second check could not run",
} as const;

type Checked = Pick<ProposalView, "engineCheck" | "engineHeld" | "auditorVerdict" | "auditorConcerns">;

// The card's label. Null when the page did not read the engine check at all (engineCheck left
// out), so a page that does not know says nothing rather than "not checked". auditorOn says
// whether a missing verdict is still to come or the second check is switched off.
export function verification(p: Checked, auditorOn: boolean): Verification | null {
  if (p.engineCheck === undefined) return null;
  const held = p.engineCheck === "mismatch" && p.engineHeld === true;
  if (p.engineCheck === "mismatch") return { state: "mismatch", line: held ? VERIFY_LINES.held : VERIFY_LINES.mismatch, held };
  const unverified = (line: string): Verification => ({ state: "unverified", line, held: false });
  if (p.engineCheck === null) return unverified(p.auditorVerdict === null ? VERIFY_LINES.notChecked : VERIFY_LINES.rulesNotChecked);
  if (p.engineCheck !== "matched") return unverified(VERIFY_LINES.unavailable);
  const v = p.auditorVerdict;
  if (v === "pass") return { state: "verified", line: VERIFY_LINES.verified, held: false };
  if (v === null) return unverified(auditorOn ? VERIFY_LINES.pending : VERIFY_LINES.off);
  if (v === "concerns") return unverified(VERIFY_LINES.concerns);
  if (v === "block") return unverified(VERIFY_LINES.block);
  if (v === "unknown" && p.auditorConcerns.includes("budget")) return unverified(VERIFY_LINES.budget);
  return unverified(VERIFY_LINES.unknown);
}

// The answer's header: a pill, and for Unverified the reason, one fixed sentence.
export type AnswerVerification = { state: "verified" | "unverified"; pill: string; reason: string | null; help: TermId };

export const ANSWER_PILL = { verified: "Verified by your records", unverified: "Unverified" } as const;

export const ANSWER_REASONS = {
  withheld: "Some figures did not come from a record and were left out.",
  unknown: "Not every figure could be traced to a record.",
  cards: "Not every request below is verified yet.",
} as const;

// The answer's header. Only for an answer that finished (done or partial) and was read with its
// steps' counts: Verified when every finished model step recorded zero withheld figures and every
// card in the turn is Verified; a plain answer with no card reads Verified with its own help. An
// unknown count is not verified.
export function answerVerification(
  turn: Pick<TurnView, "status" | "proposals" | "withheldFigures">,
  auditorOn: boolean,
): AnswerVerification | null {
  if (turn.status !== "done" && turn.status !== "partial") return null;
  if (turn.withheldFigures === undefined) return null;
  const unverified = (reason: string): AnswerVerification => ({
    state: "unverified",
    pill: ANSWER_PILL.unverified,
    reason,
    help: "unverified",
  });
  if (turn.withheldFigures === null) return unverified(ANSWER_REASONS.unknown);
  if (turn.withheldFigures > 0) return unverified(ANSWER_REASONS.withheld);
  const verified = (help: TermId): AnswerVerification => ({ state: "verified", pill: ANSWER_PILL.verified, reason: null, help });
  if (turn.proposals.length === 0) return verified("verified-answer");
  return turn.proposals.every((p) => verification(p, auditorOn)?.state === "verified")
    ? verified("verified")
    : unverified(ANSWER_REASONS.cards);
}
