import { describe, expect, it } from "vitest";
import {
  decide,
  isPaused,
  isPolicyReason,
  POLICY_REASONS,
  recordOf,
  type PolicyInput,
  type PolicyReason,
  type RuleFacts,
} from "./policy";

// The autopilot's one decision, pure: every refusal reason from a fixed base that passes, the
// boundaries of each limit, and the pause. Fixed instants only; no clock, no database.

const START = Date.parse("2026-10-31T04:00:00.000Z");
const RULE_ID = "3f0c2a8e-5b1d-4c7e-9a6f-2d8b4e1c0a9f";

const rule = (over: Partial<RuleFacts> = {}): RuleFacts => ({
  id: RULE_ID,
  version: 3,
  kind: "invoice_post",
  mode: "auto",
  maxCents: 150_000,
  dayMaxCents: 500_000,
  dayMaxCount: 5,
  ...over,
});

function base(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    switch: {
      enabled: true,
      armed: true,
      kinds: { invoice_post: { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25 } },
    },
    paused: false,
    startMs: START,
    rule: rule(),
    proposal: {
      kind: "invoice_post",
      status: "proposed",
      amountCents: 120_000,
      createdAtMs: START + 3_600_000,
      flagged: false,
      auditorVerdict: "pass",
      engineCheck: "matched",
    },
    today: { cents: 100_000, count: 1 },
    ...over,
  };
}

const withProposal = (over: Partial<PolicyInput["proposal"]>) => base({ proposal: { ...base().proposal, ...over } });

describe("decide", () => {
  it("approves inside every limit, and names the lower of the rule and the ceiling", () => {
    expect(decide(base())).toEqual({
      decision: "auto",
      reason: "within_limits",
      limits: { maxCents: 150_000, dayMaxCents: 500_000, dayMaxCount: 5 },
    });
    // A rule above the ceiling is held to the ceiling.
    const high = decide(base({ rule: rule({ maxCents: 900_000, dayMaxCents: 900_000_000, dayMaxCount: 9_000 }) }));
    expect(high.limits).toEqual({ maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25 });
  });

  const holds: [PolicyReason, PolicyInput][] = [
    ["switched_off", base({ switch: { ...base().switch, enabled: false } })],
    ["unarmed", base({ switch: { ...base().switch, armed: false } })],
    ["paused", base({ paused: true })],
    ["not_waiting", withProposal({ status: "approved" })],
  ];
  it.each(holds)("holds on %s, deciding nothing", (reason, input) => {
    expect(decide(input)).toEqual({ decision: "hold", reason, limits: null });
  });

  it("checks the switch before the pause and the pause before the row", () => {
    const all = base({ switch: { ...base().switch, enabled: false, armed: false }, paused: true });
    expect(decide(all).reason).toBe("switched_off");
    expect(decide({ ...all, switch: { ...all.switch, enabled: true } }).reason).toBe("unarmed");
    expect(decide({ ...withProposal({ status: "done" }), paused: true }).reason).toBe("paused");
  });

  const asks: [PolicyReason, PolicyInput][] = [
    ["kind_not_allowed", withProposal({ kind: "advance_payout" })],
    // An inherited name is not a kind the switch allows.
    ["kind_not_allowed", withProposal({ kind: "toString" })],
    ["bad_limit", base({ switch: { ...base().switch, kinds: { invoice_post: { maxCents: 1.5, dayMaxCents: 10, dayMaxCount: 1 } } } })],
    ["no_rule", base({ rule: null })],
    ["no_rule", base({ rule: rule({ kind: "card_match" }) })],
    ["mode_ask", base({ rule: rule({ mode: "ask" }) })],
    ["mode_ask", base({ rule: rule({ mode: "AUTO" }) })],
    ["bad_limit", base({ rule: rule({ maxCents: -1 }) })],
    ["bad_limit", base({ rule: rule({ dayMaxCount: Number.NaN }) })],
    ["bad_limit", base({ rule: rule({ version: 0 }) })],
    ["before_start", withProposal({ createdAtMs: START - 1 })],
    ["before_start", base({ startMs: Number.NaN })],
    ["before_start", withProposal({ createdAtMs: Number.NaN })],
    ["flagged", withProposal({ flagged: true })],
    ["not_audited", withProposal({ auditorVerdict: null })],
    ["audit_not_pass", withProposal({ auditorVerdict: "concerns" })],
    ["audit_not_pass", withProposal({ auditorVerdict: "block" })],
    ["audit_not_pass", withProposal({ auditorVerdict: "unknown" })],
    ["engine_unverified", withProposal({ engineCheck: "unavailable" })],
    ["engine_unverified", withProposal({ engineCheck: "mismatch" })],
    ["engine_unverified", withProposal({ engineCheck: null })],
    ["bad_amount", withProposal({ amountCents: 12.5 })],
    ["bad_amount", withProposal({ amountCents: -100 })],
    ["bad_amount", withProposal({ amountCents: Number.NaN })],
    ["unknown_today", base({ today: null })],
    ["unknown_today", base({ today: { cents: Number.NaN, count: 0 } })],
    ["over_item_limit", withProposal({ amountCents: 150_001 })],
    ["over_day_cents", base({ today: { cents: 380_001, count: 1 } })],
    ["over_day_count", base({ today: { cents: 0, count: 5 } })],
  ];
  it.each(asks)("leaves it for a person on %s", (reason, input) => {
    const r = decide(input);
    expect(r.decision).toBe("ask");
    expect(r.reason).toBe(reason);
  });

  it("keeps a kind the owner set to Off for people", () => {
    expect(decide(base({ rule: rule({ mode: "off" }) }))).toEqual({ decision: "off", reason: "mode_off", limits: null });
  });

  it("allows the exact limits and refuses one cent or one item past them", () => {
    expect(decide(withProposal({ amountCents: 150_000 })).decision).toBe("auto");
    expect(decide(base({ today: { cents: 380_000, count: 1 } })).decision).toBe("auto");
    expect(decide(base({ today: { cents: 0, count: 4 } })).decision).toBe("auto");
    expect(decide(withProposal({ createdAtMs: START })).decision).toBe("auto");
    // A zero limit approves nothing above zero.
    expect(decide(base({ rule: rule({ maxCents: 0 }) })).reason).toBe("over_item_limit");
    expect(decide(base({ rule: rule({ dayMaxCount: 0 }) })).reason).toBe("over_day_count");
  });

  it("covers every reason it can give", () => {
    const given = new Set<PolicyReason>([
      "within_limits",
      "mode_off",
      ...holds.map(([r]) => r),
      ...asks.map(([r]) => r),
    ]);
    expect([...given].sort()).toEqual([...POLICY_REASONS].sort());
  });

  it("answers the same way for the same input", () => {
    const input = base({ today: { cents: 380_001, count: 1 } });
    expect(decide(input)).toEqual(decide(structuredClone(input)));
  });
});

describe("isPaused", () => {
  const NOW = Date.parse("2026-10-31T12:00:00.000Z");
  it("reads no row and no pause as running", () => {
    expect(isPaused(null, NOW)).toBe(false);
    expect(isPaused({ pausedAtMs: null, pausedUntilMs: null }, NOW)).toBe(false);
  });
  it("holds a pause with no end, and a timed one until its end", () => {
    expect(isPaused({ pausedAtMs: NOW - 1, pausedUntilMs: null }, NOW)).toBe(true);
    expect(isPaused({ pausedAtMs: NOW - 1, pausedUntilMs: NOW + 1 }, NOW)).toBe(true);
    expect(isPaused({ pausedAtMs: NOW - 10, pausedUntilMs: NOW }, NOW)).toBe(false);
  });
  it("counts a time that does not read as paused", () => {
    expect(isPaused({ pausedAtMs: Number.NaN, pausedUntilMs: null }, NOW)).toBe(true);
    expect(isPaused({ pausedAtMs: NOW - 1, pausedUntilMs: Number.NaN }, NOW)).toBe(true);
    expect(isPaused({ pausedAtMs: NOW - 1, pausedUntilMs: NOW + 1 }, Number.NaN)).toBe(true);
  });
});

describe("recordOf", () => {
  it("stores the mode, the reason, the rule and the totals it read, and nothing else", () => {
    const r = decide(base());
    if (r.decision === "hold") throw new Error("expected a decision");
    expect(recordOf({ ...r, decision: r.decision }, rule(), { cents: 100_000, count: 1 })).toEqual({
      mode: "auto",
      reason: "within_limits",
      ruleId: RULE_ID,
      ruleVersion: 3,
      maxCents: 150_000,
      dayMaxCents: 500_000,
      dayMaxCount: 5,
      dayCents: 100_000,
      dayCount: 1,
    });
    expect(recordOf({ decision: "ask", reason: "no_rule", limits: null }, null, null)).toEqual({
      mode: "ask",
      reason: "no_rule",
      ruleId: null,
      ruleVersion: null,
      maxCents: null,
      dayMaxCents: null,
      dayMaxCount: null,
      dayCents: null,
      dayCount: null,
    });
  });
  it("knows its own reason words", () => {
    expect(isPolicyReason("within_limits")).toBe(true);
    expect(isPolicyReason("gate_refused")).toBe(false);
    expect(isPolicyReason(7)).toBe(false);
  });
});
