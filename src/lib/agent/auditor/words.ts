// The auditor's fixed words, shared by the server (the approve gate, the audit route) and the
// card. No imports: the browser bundle takes this file as it is.

export const AUDIT_VERDICTS = ["pass", "concerns", "block", "unknown"] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

// What the model may name. "budget" is added on storage only: the auditor could not check because
// the demo budget was reached. The model never emits it.
export const MODEL_CONCERNS = [
  "cause_wrong",
  "amount_wrong",
  "source_missing",
  "record_mismatch",
  "limit_exceeded",
  "flagged_input",
  "insufficient_evidence",
] as const;
export const AUDIT_CONCERNS = [...MODEL_CONCERNS, "budget"] as const;
export type AuditConcern = (typeof AUDIT_CONCERNS)[number];

// One plain sentence per concern, for the card.
export const CONCERN_SENTENCES: Readonly<Record<AuditConcern, string>> = {
  cause_wrong: "the cause given does not match the records",
  amount_wrong: "the amount does not match the number from your pay rules",
  source_missing: "a record behind it is missing",
  record_mismatch: "the records point at a different driver, load or invoice",
  limit_exceeded: "the amount is over the limit",
  flagged_input: "it was built on a message that failed screening",
  insufficient_evidence: "there was not enough evidence to check it",
  budget: "the demo budget was reached",
};

// Short names for the confirm question ("The second check has a concern (source missing).").
export const CONCERN_NAMES: Readonly<Record<AuditConcern, string>> = {
  cause_wrong: "cause wrong",
  amount_wrong: "amount wrong",
  source_missing: "source missing",
  record_mismatch: "record mismatch",
  limit_exceeded: "over the limit",
  flagged_input: "flagged message",
  insufficient_evidence: "not enough evidence",
  budget: "demo budget reached",
};

// A person's reason for approving over a block: trimmed, 10 to 240 characters. The gate, the
// route and the card all read this one value; the database checks the same range.
export const OVERRIDE_REASON = { min: 10, max: 240 } as const;

export function isAuditConcern(value: unknown): value is AuditConcern {
  return typeof value === "string" && (AUDIT_CONCERNS as readonly string[]).includes(value);
}

export function isAuditVerdict(value: unknown): value is AuditVerdict {
  return typeof value === "string" && (AUDIT_VERDICTS as readonly string[]).includes(value);
}

// The trimmed reason when its length is in range, else null.
export function overrideReasonOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= OVERRIDE_REASON.min && trimmed.length <= OVERRIDE_REASON.max ? trimmed : null;
}

function names(concerns: readonly string[]): string {
  const known = concerns.filter(isAuditConcern).map((c) => CONCERN_NAMES[c]);
  return known.length > 0 ? known.join(", ") : CONCERN_NAMES.insufficient_evidence;
}

// The card's line: one sentence, capitalized and ending in a period.
export function sentences(concerns: readonly string[]): string {
  const known = concerns.filter(isAuditConcern).map((c) => CONCERN_SENTENCES[c]);
  const text = known.length > 0 ? known.join("; ") : CONCERN_SENTENCES.insufficient_evidence;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// The confirm question the card asks for a verdict that needs the second confirm.
export function auditConfirmQuestion(verdict: string | null, concerns: readonly string[]): string | null {
  if (verdict === "concerns") {
    const word = concerns.length > 1 ? "concerns" : "a concern";
    return `The second check has ${word} (${names(concerns)}). Approve anyway?`;
  }
  if (verdict === "unknown") return "The second check could not run. Approve anyway?";
  return null;
}
