import { flags } from "../../config/flags";

// The one ceiling over every run's own loop (agents-101 3.3): a run's effective limit is the
// smaller of its own cap and maxTurns, never looser. A turn is defined by each run (a sweep
// finding drafted, a fan-out driver check, a portal model step). A maxTurns that is not a whole
// number of zero or more reads as zero, and so does a cap that is not a number, so a bad value
// stops the run rather than lifting its limit.
export function clampToMaxTurns(cap: number, maxTurns: number = flags.runLimits.maxTurns): number {
  const ceiling = Number.isSafeInteger(maxTurns) && maxTurns >= 0 ? maxTurns : 0;
  if (Number.isNaN(cap)) return 0;
  return Math.min(cap, ceiling);
}
