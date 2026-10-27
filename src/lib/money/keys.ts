import { MAX_ATTEMPT, MONEY_ACTION_KINDS, type MoneyActionKind } from "./types";

// The two keys of a money action, both pure and both derived from stored values, so a process
// that crashed mid-send re-derives the same outside request. The table's CHECKs hold the same
// formulas, so a key built any other way cannot be stored.

// Lowercase only: the form Postgres returns, so a key built here equals the key read back.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function isAttempt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ATTEMPT;
}

// `kind:subjectId:attempt`. One subject, one kind, one try.
export function idempotencyKey(kind: MoneyActionKind, subjectId: string, attempt: number): string {
  if (!(MONEY_ACTION_KINDS as readonly string[]).includes(kind)) throw new RangeError("unknown kind");
  if (!isCanonicalUuid(subjectId)) throw new RangeError("subject id is not a lowercase UUID");
  if (!isAttempt(attempt)) throw new RangeError(`attempt must be 1 to ${MAX_ATTEMPT}`);
  return `${kind}:${subjectId}:${attempt}`;
}

// The action's id without dashes: 32 hex characters, inside the accounting system's 50-character
// request id and the payment processor's 255-character idempotency key. The outside system
// replays the original answer for a repeated request id, so the ledger's key and the outside
// key are one.
export function requestIdOf(actionId: string): string {
  if (!isCanonicalUuid(actionId)) throw new RangeError("action id is not a lowercase UUID");
  return actionId.replace(/-/g, "");
}

// A short reference the payment adapter logs and may attach to a payout: which record it pays,
// never a person's name.
export function memoCodeOf(action: { subjectTable: string; subjectId: string }): string {
  return `${action.subjectTable}:${action.subjectId}`;
}
