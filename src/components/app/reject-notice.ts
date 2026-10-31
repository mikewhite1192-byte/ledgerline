// What a person reads when the reject route refuses a card whose money already moved
// (src/lib/proposals/reject.ts, reject_after_money_moved). One copy, so every screen with a Reject
// button says the same; every other refusal keeps that screen's own sentence.
export const REJECT_AFTER_MONEY_MOVED = "reject_after_money_moved";
export const REJECT_MONEY_MOVED_NOTICE =
  "Money for this card already moved, so it can't be rejected. Check the card's status.";

export function rejectNotice(category: unknown, fallback: string): string {
  return category === REJECT_AFTER_MONEY_MOVED ? REJECT_MONEY_MOVED_NOTICE : fallback;
}
