import { flags } from "../../config/flags";
import { isLocalDate, localDateOf } from "../time/local-date";

// Parked advances (flags.advanceParking): why a person's approval of an advance stopped short of
// paying, from a closed list. The executor (approve.ts) gathers the facts under the proposal and
// driver locks; this file only picks the reason, so the order is one rule in one place.

export const PARK_REASONS = ["card_removed", "name_mismatch", "no_room", "override"] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export function isParkReason(value: unknown): value is ParkReason {
  return typeof value === "string" && (PARK_REASONS as readonly string[]).includes(value);
}

export type ParkFacts = {
  // The card the proposal names, or else the driver's default, is still one of their active cards.
  cardOnFile: boolean;
  // Whether the card statement names the card's holder as the records do; null when not checked
  // (no card, or no statement row for it).
  nameMatches: boolean | null;
  // The pay rules allow exactly this amount as of now.
  room: boolean;
  // The approval went over an auditor block or an engine mismatch.
  overridden: boolean;
};

// The first reason that holds, in this order, or null when the advance may go ahead.
export function parkReasonOf(f: ParkFacts): ParkReason | null {
  if (!f.cardOnFile) return "card_removed";
  if (f.nameMatches === false) return "name_mismatch";
  if (!f.room) return "no_room";
  if (f.overridden) return "override";
  return null;
}

// Whether a proposal made at createdAt (an instant) may park: the switch is on, read now, and the
// proposal was made on or after its start date in the carrier's zone.
export function parkingOn(createdAt: string, zone: string): boolean {
  const s = flags.advanceParking;
  return s.enabled === true && isLocalDate(s.startDate) && localDateOf(createdAt, zone) >= s.startDate;
}

// A park reason in words, for the record page and the approval card.
export const PARK_REASON_WORDS: Readonly<Record<ParkReason, string>> = {
  card_removed: "The card is no longer on file",
  name_mismatch: "The card statement names someone else",
  no_room: "The pay rules no longer allow this amount",
  override: "Approved over a block or a mismatch",
};
