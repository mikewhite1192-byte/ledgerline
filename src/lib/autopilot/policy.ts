import type { AutopilotCeiling } from "../../config/flags";

// The autopilot's one decision, pure: no clock, no database, no model. It reads the switch, the
// pause, the owner's rule for the kind, the proposal's stored checks and today's totals, and says
// auto (the autopilot login may approve it now), ask (it waits for a person), off (the owner keeps
// this kind for people) or hold (nothing is decided or written now). Every amount is whole cents;
// every instant is ms since the epoch, read by the caller. The checks run in a fixed order and the
// first one that stops it gives the reason, so the same input always gives the same answer.

export const POLICY_REASONS = [
  // hold: nothing is decided or written now.
  "switched_off",
  "unarmed",
  "paused",
  "not_waiting",
  // ask or off: a person decides.
  "kind_not_allowed",
  "bad_limit",
  "no_rule",
  "mode_off",
  "mode_ask",
  "before_start",
  "flagged",
  "not_audited",
  "audit_not_pass",
  "engine_unverified",
  "bad_amount",
  "unknown_today",
  "over_item_limit",
  "over_day_cents",
  "over_day_count",
  // auto.
  "within_limits",
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export type PolicyDecision = "auto" | "ask" | "off" | "hold";

export function isPolicyReason(value: unknown): value is PolicyReason {
  return typeof value === "string" && (POLICY_REASONS as readonly string[]).includes(value);
}

export type PolicySwitch = {
  enabled: boolean;
  armed: boolean;
  kinds: Readonly<Partial<Record<string, AutopilotCeiling>>>;
};

export type RuleFacts = {
  id: string;
  version: number;
  kind: string;
  mode: string;
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
};

export type ProposalFacts = {
  kind: string;
  status: string;
  amountCents: number;
  createdAtMs: number;
  flagged: boolean;
  auditorVerdict: string | null;
  engineCheck: string | null;
};

// What the autopilot already approved today for this kind (every outcome, an unknown one too).
export type DayTotals = { cents: number; count: number };

export type Limits = { maxCents: number; dayMaxCents: number; dayMaxCount: number };

export type PolicyInput = {
  switch: PolicySwitch;
  paused: boolean;
  // The start date's local midnight in the carrier's zone; NaN when it does not read (nothing is
  // after it then).
  startMs: number;
  rule: RuleFacts | null;
  proposal: ProposalFacts;
  // null: the read did not answer. Unknown is not zero.
  today: DayTotals | null;
};

export type PolicyResult = {
  decision: PolicyDecision;
  reason: PolicyReason;
  // The limits it applied (the lower of the owner's rule and the ceiling), once both are read.
  limits: Limits | null;
};

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function wholeLimits(l: Limits | AutopilotCeiling | RuleFacts): boolean {
  return whole(l.maxCents) && whole(l.dayMaxCents) && whole(l.dayMaxCount);
}

const out = (decision: PolicyDecision, reason: PolicyReason, limits: Limits | null = null): PolicyResult => ({
  decision,
  reason,
  limits,
});

export function decide(input: PolicyInput): PolicyResult {
  const { proposal: p, rule } = input;
  if (input.switch.enabled !== true) return out("hold", "switched_off");
  if (input.switch.armed !== true) return out("hold", "unarmed");
  if (input.paused !== false) return out("hold", "paused");
  if (p.status !== "proposed") return out("hold", "not_waiting");
  const kinds = input.switch.kinds;
  const ceiling = Object.prototype.hasOwnProperty.call(kinds, p.kind) ? kinds[p.kind] : undefined;
  if (!ceiling) return out("ask", "kind_not_allowed");
  if (!wholeLimits(ceiling)) return out("ask", "bad_limit");
  if (rule === null || rule.kind !== p.kind) return out("ask", "no_rule");
  if (rule.mode === "off") return out("off", "mode_off");
  if (rule.mode !== "auto") return out("ask", "mode_ask");
  if (!wholeLimits(rule) || !Number.isSafeInteger(rule.version) || rule.version < 1) return out("ask", "bad_limit");
  const limits: Limits = {
    maxCents: Math.min(rule.maxCents, ceiling.maxCents),
    dayMaxCents: Math.min(rule.dayMaxCents, ceiling.dayMaxCents),
    dayMaxCount: Math.min(rule.dayMaxCount, ceiling.dayMaxCount),
  };
  if (!Number.isFinite(input.startMs) || !Number.isFinite(p.createdAtMs) || p.createdAtMs < input.startMs) {
    return out("ask", "before_start", limits);
  }
  if (p.flagged !== false) return out("ask", "flagged", limits);
  if (p.auditorVerdict === null) return out("ask", "not_audited", limits);
  if (p.auditorVerdict !== "pass") return out("ask", "audit_not_pass", limits);
  if (p.engineCheck !== "matched") return out("ask", "engine_unverified", limits);
  if (!whole(p.amountCents)) return out("ask", "bad_amount", limits);
  const today = input.today;
  if (today === null || !whole(today.cents) || !whole(today.count)) return out("ask", "unknown_today", limits);
  if (p.amountCents > limits.maxCents) return out("ask", "over_item_limit", limits);
  if (today.cents + p.amountCents > limits.dayMaxCents) return out("ask", "over_day_cents", limits);
  if (today.count + 1 > limits.dayMaxCount) return out("ask", "over_day_count", limits);
  return out("auto", "within_limits", limits);
}

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

// What is stored on the proposal (proposals.autopilot_decision): the mode, the reason word, the
// rule it was decided on and the totals it read. Ids, whole numbers and words only.
export type DecisionRecord = {
  mode: "auto" | "ask" | "off";
  reason: PolicyReason;
  ruleId: string | null;
  ruleVersion: number | null;
  maxCents: number | null;
  dayMaxCents: number | null;
  dayMaxCount: number | null;
  dayCents: number | null;
  dayCount: number | null;
};

export function recordOf(
  result: PolicyResult & { decision: "auto" | "ask" | "off" },
  rule: RuleFacts | null,
  today: DayTotals | null,
): DecisionRecord {
  return {
    mode: result.decision,
    reason: result.reason,
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null,
    maxCents: result.limits?.maxCents ?? null,
    dayMaxCents: result.limits?.dayMaxCents ?? null,
    dayMaxCount: result.limits?.dayMaxCount ?? null,
    dayCents: today && whole(today.cents) ? today.cents : null,
    dayCount: today && whole(today.count) ? today.count : null,
  };
}
