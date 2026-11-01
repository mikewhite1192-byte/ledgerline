import { parseInstant, type Instant } from "../time/local-date";

// MOCK-TMS: the time a change in the sample dispatch system is stamped with: now, never before the
// feed's floor (the seeded snapshot's instant, which can be ahead of the wall clock before the demo
// week starts), and always at least a second after the load's latest history row and its last
// update, so a change always reads as newer than what the mirror already holds.

export function changeAt(nowMs: number, floorAt: Instant | null, latest: readonly (Instant | null)[]): Instant {
  let at = nowMs;
  if (floorAt !== null) at = Math.max(at, parseInstant(floorAt));
  for (const l of latest) if (l !== null) at = Math.max(at, parseInstant(l) + 1000);
  return new Date(at).toISOString();
}
