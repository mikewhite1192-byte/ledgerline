import { describe, expect, it } from "vitest";
import {
  decide,
  driverOf,
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
  driverDayMaxCents: null,
  ...over,
});

function base(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    switch: {
      enabled: true,
      armed: true,
      kinds: { invoice_post: { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, armed: true } },
    },
    paused: false,
    startMs: START,
    rule: rule(),
    proposal: {
      kind: "invoice_post",
      driverId: null,
      status: "proposed",
      amountCents: 120_000,
      createdAtMs: START + 3_600_000,
      flagged: false,
      auditorVerdict: "pass",
      engineCheck: "matched",
    },
    today: { cents: 100_000, count: 1 },
    driverToday: null,
    ...over,
  };
}

// A driver's kind: an advance of $200 to one driver, inside every limit.
const DRIVER = "7a1e9c4b-2d3f-4e5a-8b6c-9d0e1f2a3b4c";
const ADVANCE = { maxCents: 30_000, dayMaxCents: 150_000, dayMaxCount: 10, driverDayMaxCents: 30_000, armed: true };
function driverBase(over: Partial<PolicyInput> = {}): PolicyInput {
  const b = base();
  return {
    ...b,
    switch: { ...b.switch, kinds: { advance_payout: ADVANCE } },
    rule: rule({ kind: "advance_payout", maxCents: 20_000, dayMaxCents: 200_000, dayMaxCount: 10, driverDayMaxCents: 30_000 }),
    proposal: { ...b.proposal, kind: "advance_payout", driverId: DRIVER, amountCents: 20_000 },
    today: { cents: 0, count: 0 },
    driverToday: { cents: 0, count: 0 },
    ...over,
  };
}

const withProposal = (over: Partial<PolicyInput["proposal"]>) => base({ proposal: { ...base().proposal, ...over } });

describe("decide", () => {
  it("approves inside every limit, and names the lower of the rule and the ceiling", () => {
    expect(decide(base())).toEqual({
      decision: "auto",
      reason: "within_limits",
      limits: { maxCents: 150_000, dayMaxCents: 500_000, dayMaxCount: 5, driverDayMaxCents: null },
    });
    // A rule above the ceiling is held to the ceiling.
    const high = decide(base({ rule: rule({ maxCents: 900_000, dayMaxCents: 900_000_000, dayMaxCount: 9_000 }) }));
    expect(high.limits).toEqual({ maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, driverDayMaxCents: null });
  });

  const holds: [PolicyReason, PolicyInput][] = [
    ["switched_off", base({ switch: { ...base().switch, enabled: false } })],
    ["unarmed", base({ switch: { ...base().switch, armed: false } })],
    ["paused", base({ paused: true })],
    ["not_waiting", withProposal({ status: "approved" })],
    ["kind_unarmed", driverBase({ switch: { ...driverBase().switch, kinds: { advance_payout: { ...ADVANCE, armed: false } } } })],
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

  // A kind a named person always approves, even with a ceiling and an Auto rule slipped in for it.
  const NEVER = { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, armed: true };
  const slipped = (kind: string) =>
    base({
      switch: { ...base().switch, kinds: { [kind]: NEVER } },
      rule: rule({ kind }),
      proposal: { ...base().proposal, kind },
    });
  const asks: [PolicyReason, PolicyInput][] = [
    ["kind_never_alone", withProposal({ kind: "escrow_release" })],
    ["kind_never_alone", slipped("settlement_approve")],
    ["kind_never_alone", slipped("escrow_release")],
    ["kind_never_alone", { ...slipped("pay_correction"), rule: null }],
    ["kind_not_allowed", withProposal({ kind: "advance_payout" })],
    // An inherited name is not a kind the switch allows.
    ["kind_not_allowed", withProposal({ kind: "toString" })],
    ["bad_limit", base({ switch: { ...base().switch, kinds: { invoice_post: { maxCents: 1.5, dayMaxCents: 10, dayMaxCount: 1, armed: true } } } })],
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
    ["bad_limit", driverBase({ rule: rule({ kind: "advance_payout", driverDayMaxCents: null }) })],
    ["no_driver", driverBase({ proposal: { ...driverBase().proposal, driverId: null } })],
    ["no_driver", driverBase({ proposal: { ...driverBase().proposal, driverId: DRIVER.toUpperCase() } })],
    ["unknown_today", driverBase({ driverToday: null })],
    ["unknown_today", driverBase({ driverToday: { cents: Number.NaN, count: 0 } })],
    ["over_driver_day_cents", driverBase({ driverToday: { cents: 10_001, count: 1 } })],
  ];
  it.each(asks)("leaves it for a person on %s", (reason, input) => {
    const r = decide(input);
    expect(r.decision).toBe("ask");
    expect(r.reason).toBe(reason);
  });

  it("refuses a never-alone kind after the holds and before the ceiling or the rule", () => {
    const s = slipped("settlement_approve");
    expect(decide(s)).toEqual({ decision: "ask", reason: "kind_never_alone", limits: null });
    expect(decide({ ...s, switch: { ...s.switch, kinds: { settlement_approve: { ...NEVER, armed: false } } } }).reason).toBe(
      "kind_never_alone",
    );
    expect(decide({ ...s, paused: true }).reason).toBe("paused");
    expect(decide({ ...s, proposal: { ...s.proposal, status: "approved" } }).reason).toBe("not_waiting");
  });

  it("holds a kind whose own ceiling is not armed, before it reads the rule", () => {
    const unarmed = driverBase({ switch: { ...driverBase().switch, kinds: { advance_payout: { ...ADVANCE, armed: false } } } });
    expect(decide(unarmed)).toEqual({ decision: "hold", reason: "kind_unarmed", limits: null });
    expect(decide({ ...unarmed, rule: null }).reason).toBe("kind_unarmed");
    expect(decide({ ...unarmed, rule: rule({ kind: "advance_payout", mode: "off" }) }).reason).toBe("kind_unarmed");
  });

  it("holds a driver's kind to the lower driver's day, and allows its exact limit", () => {
    expect(decide(driverBase())).toEqual({
      decision: "auto",
      reason: "within_limits",
      limits: { maxCents: 20_000, dayMaxCents: 150_000, dayMaxCount: 10, driverDayMaxCents: 30_000 },
    });
    // 10_000 already today plus 20_000 is the driver's limit exactly; one cent more is past it.
    expect(decide(driverBase({ driverToday: { cents: 10_000, count: 1 } })).decision).toBe("auto");
    expect(decide(driverBase({ driverToday: { cents: 10_001, count: 1 } })).reason).toBe("over_driver_day_cents");
    // The ceiling's driver's day is lower than the rule's here, so it holds.
    const low = driverBase({ switch: { ...driverBase().switch, kinds: { advance_payout: { ...ADVANCE, driverDayMaxCents: 25_000 } } } });
    expect(decide(low).limits?.driverDayMaxCents).toBe(25_000);
    expect(decide({ ...low, driverToday: { cents: 5_001, count: 1 } }).reason).toBe("over_driver_day_cents");
    // The driver's day is checked before the carrier's.
    expect(decide(driverBase({ driverToday: { cents: 10_001, count: 1 }, today: { cents: 150_000, count: 1 } })).reason).toBe(
      "over_driver_day_cents",
    );
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

describe("driverOf", () => {
  it("reads an advance's driver from its subject and a money code's from its args", () => {
    expect(driverOf("advance_payout", { subjectTable: "drivers", subjectId: DRIVER, args: {} })).toBe(DRIVER);
    expect(driverOf("advance_payout", { subjectTable: "loads", subjectId: DRIVER, args: { driverId: DRIVER } })).toBeNull();
    expect(driverOf("money_code", { subjectTable: "loads", subjectId: RULE_ID, args: { driverId: DRIVER } })).toBe(DRIVER);
    expect(driverOf("money_code", { subjectTable: "loads", subjectId: RULE_ID, args: { driverId: DRIVER.toUpperCase() } })).toBeNull();
    expect(driverOf("money_code", { subjectTable: "loads", subjectId: RULE_ID, args: {} })).toBeNull();
    expect(driverOf("invoice_post", { subjectTable: "drivers", subjectId: DRIVER, args: { driverId: DRIVER } })).toBeNull();
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
      driverId: null,
      driverDayMaxCents: null,
      driverDayCents: null,
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
      driverId: null,
      driverDayMaxCents: null,
      driverDayCents: null,
    });
  });
  it("stores the driver, the driver's limit and the driver's total on a driver's kind", () => {
    const input = driverBase({ driverToday: { cents: 10_000, count: 1 } });
    const r = decide(input);
    if (r.decision === "hold") throw new Error("expected a decision");
    expect(
      recordOf({ ...r, decision: r.decision }, input.rule, input.today, { id: DRIVER, today: input.driverToday }),
    ).toMatchObject({ mode: "auto", driverId: DRIVER, driverDayMaxCents: 30_000, driverDayCents: 10_000 });
    // An id or a total that does not read is stored as null.
    expect(
      recordOf({ ...r, decision: r.decision }, input.rule, input.today, { id: "nope", today: { cents: -1, count: 0 } }),
    ).toMatchObject({ driverId: null, driverDayCents: null });
  });
  it("knows its own reason words", () => {
    expect(isPolicyReason("within_limits")).toBe(true);
    expect(isPolicyReason("gate_refused")).toBe(false);
    expect(isPolicyReason(7)).toBe(false);
  });
});
