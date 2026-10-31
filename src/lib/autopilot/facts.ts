// The facts the autopilot policy (./policy) reads, and the pause check, with no money import, so
// code an agent file reaches (./mode, ./read) can use them without reaching money code.

export type RuleFacts = {
  id: string;
  version: number;
  kind: string;
  mode: string;
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
  // One driver's local day; null on a rule that has none (required on a driver kind).
  driverDayMaxCents: number | null;
};

// What the autopilot already approved today for this kind (every outcome, an unknown one too).
export type DayTotals = { cents: number; count: number };

// The carrier's pause at one instant. No row, or no pause, is not paused; a pause with no end
// holds until a person resumes it; one with an end holds until then. A time that does not read
// counts as paused.
export type PauseFacts = { pausedAtMs: number | null; pausedUntilMs: number | null };

export function isPaused(state: PauseFacts | null, nowMs: number): boolean {
  if (state === null || state.pausedAtMs === null) return false;
  if (!Number.isFinite(state.pausedAtMs)) return true;
  if (state.pausedUntilMs === null) return true;
  if (!Number.isFinite(state.pausedUntilMs) || !Number.isFinite(nowMs)) return true;
  return state.pausedUntilMs > nowMs;
}
