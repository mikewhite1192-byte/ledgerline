import type { AutopilotCeiling } from "../../config/flags";
import { isCanonicalUuid } from "../money/keys";
import { isNeverAloneKind } from "../money/never-alone";
import { isPaused, type DayTotals, type PauseFacts, type RuleFacts } from "./facts";

// The shapes it reads live in ./facts, which agent code may reach (this file reads the
// never-alone list from money code, which agent code may not).
export { isPaused, type DayTotals, type PauseFacts, type RuleFacts };

// The autopilot's one decision, pure: no clock, no database, no model. It reads the switch, the
// pause, the owner's rule for the kind, the proposal's stored checks and today's totals, and says
// auto (the autopilot login may approve it now), ask (it waits for a person), off (the owner keeps
// this kind for people) or hold (nothing is decided or written now). Every amount is whole cents;
// every instant is ms since the epoch, read by the caller. The checks run in a fixed order and the
// first one that stops it gives the reason, so the same input always gives the same answer. A kind
// that pays a driver (DRIVER_KINDS) is held to one driver's local day as well as the carrier's.

export const POLICY_REASONS = [
  // hold: nothing is decided or written now.
  "switched_off",
  "unarmed",
  "paused",
  "not_waiting",
  "kind_unarmed",
  // ask or off: a person decides.
  // A kind a named person always approves (src/lib/money/never-alone.ts), before any rule is read.
  "kind_never_alone",
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
  "no_driver",
  "unknown_today",
  "over_item_limit",
  "over_driver_day_cents",
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

export type ProposalFacts = {
  kind: string;
  // The driver it pays (driverOf), on a driver kind; null otherwise or when it does not read.
  driverId: string | null;
  status: string;
  amountCents: number;
  createdAtMs: number;
  flagged: boolean;
  auditorVerdict: string | null;
  engineCheck: string | null;
};

// driverDayMaxCents: null on a kind that pays no driver.
export type Limits = { maxCents: number; dayMaxCents: number; dayMaxCount: number; driverDayMaxCents: number | null };

// The kinds that pay one driver, held to that driver's day too.
export const DRIVER_KINDS: ReadonlySet<string> = new Set(["advance_payout", "money_code"]);

// The driver a proposal pays, from its stored subject and args, as a whole canonical id: an
// advance's subject is the driver; a money code's subject is the load and its args name the
// driver. Null for any other kind, and for an id that does not read whole. Pure.
export function driverOf(
  kind: string,
  p: { subjectTable: string; subjectId: string; args: Readonly<Record<string, unknown>> },
): string | null {
  if (kind === "advance_payout") return p.subjectTable === "drivers" && isCanonicalUuid(p.subjectId) ? p.subjectId : null;
  if (kind === "money_code") return isCanonicalUuid(p.args.driverId) ? p.args.driverId : null;
  return null;
}

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
  // The same for the proposal's driver alone, on a driver kind; null when not read.
  driverToday: DayTotals | null;
};

export type PolicyResult = {
  decision: PolicyDecision;
  reason: PolicyReason;
  // The limits it applied (the lower of the owner's rule and the ceiling), once both are read.
  limits: Limits | null;
};

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// The three limits whole, and on a driver kind the driver's day too.
function wholeLimits(l: AutopilotCeiling | RuleFacts, driverKind: boolean): boolean {
  return (
    whole(l.maxCents) && whole(l.dayMaxCents) && whole(l.dayMaxCount) && (!driverKind || whole(l.driverDayMaxCents))
  );
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
  // Never the autopilot's, whatever the switch lists or a rule row says.
  if (isNeverAloneKind(p.kind)) return out("ask", "kind_never_alone");
  const kinds = input.switch.kinds;
  const ceiling = Object.prototype.hasOwnProperty.call(kinds, p.kind) ? kinds[p.kind] : undefined;
  if (!ceiling) return out("ask", "kind_not_allowed");
  // A listed kind not armed yet: nothing is decided or written, so arming it finds it still waiting.
  if (ceiling.armed !== true) return out("hold", "kind_unarmed");
  const driverKind = DRIVER_KINDS.has(p.kind);
  if (!wholeLimits(ceiling, driverKind)) return out("ask", "bad_limit");
  if (rule === null || rule.kind !== p.kind) return out("ask", "no_rule");
  if (rule.mode === "off") return out("off", "mode_off");
  if (rule.mode !== "auto") return out("ask", "mode_ask");
  if (!wholeLimits(rule, driverKind) || !Number.isSafeInteger(rule.version) || rule.version < 1) {
    return out("ask", "bad_limit");
  }
  const limits: Limits = {
    maxCents: Math.min(rule.maxCents, ceiling.maxCents),
    dayMaxCents: Math.min(rule.dayMaxCents, ceiling.dayMaxCents),
    dayMaxCount: Math.min(rule.dayMaxCount, ceiling.dayMaxCount),
    driverDayMaxCents:
      driverKind && whole(rule.driverDayMaxCents) && whole(ceiling.driverDayMaxCents)
        ? Math.min(rule.driverDayMaxCents, ceiling.driverDayMaxCents)
        : null,
  };
  if (!Number.isFinite(input.startMs) || !Number.isFinite(p.createdAtMs) || p.createdAtMs < input.startMs) {
    return out("ask", "before_start", limits);
  }
  if (p.flagged !== false) return out("ask", "flagged", limits);
  if (p.auditorVerdict === null) return out("ask", "not_audited", limits);
  if (p.auditorVerdict !== "pass") return out("ask", "audit_not_pass", limits);
  if (p.engineCheck !== "matched") return out("ask", "engine_unverified", limits);
  if (!whole(p.amountCents)) return out("ask", "bad_amount", limits);
  if (driverKind && !isCanonicalUuid(p.driverId)) return out("ask", "no_driver", limits);
  const today = input.today;
  if (today === null || !whole(today.cents) || !whole(today.count)) return out("ask", "unknown_today", limits);
  // The driver's own total, read on a driver kind only.
  const driverToday = driverKind ? input.driverToday : null;
  if (driverKind && (driverToday === null || !whole(driverToday.cents) || !whole(driverToday.count))) {
    return out("ask", "unknown_today", limits);
  }
  if (p.amountCents > limits.maxCents) return out("ask", "over_item_limit", limits);
  if (
    driverToday !== null &&
    (limits.driverDayMaxCents === null || driverToday.cents + p.amountCents > limits.driverDayMaxCents)
  ) {
    return out("ask", "over_driver_day_cents", limits);
  }
  if (today.cents + p.amountCents > limits.dayMaxCents) return out("ask", "over_day_cents", limits);
  if (today.count + 1 > limits.dayMaxCount) return out("ask", "over_day_count", limits);
  return out("auto", "within_limits", limits);
}

// What is stored on the proposal (proposals.autopilot_decision): the mode, the reason word, the
// rule it was decided on and the totals it read, and on a driver kind the driver, the driver's
// limit and the driver's total. Ids, whole numbers and words only.
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
  driverId: string | null;
  driverDayMaxCents: number | null;
  driverDayCents: number | null;
};

export function recordOf(
  result: PolicyResult & { decision: "auto" | "ask" | "off" },
  rule: RuleFacts | null,
  today: DayTotals | null,
  driver: { id: string | null; today: DayTotals | null } = { id: null, today: null },
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
    driverId: isCanonicalUuid(driver.id) ? driver.id : null,
    driverDayMaxCents: result.limits?.driverDayMaxCents ?? null,
    driverDayCents: driver.today && whole(driver.today.cents) ? driver.today.cents : null,
  };
}
