import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { AiResult } from "../../../ai";
import { changeArgsOf, ruleChangeOf, type RuleChange, type RuleChangeArgs } from "../../../pay-rules/change";
import { impactLine, refusalLine } from "../../../pay-rules/words";
import { callTool } from "../index";
import { PROPOSAL_TITLES, impactOf } from "../store";
import type { CompleteFn, GatewayContext } from "../types";
import { context, fixedClock, type Handler } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// The two pay rule change tools on the real readers and the real rules engine over the synthetic
// seed plan, at a fixed instant (Tuesday Oct 27, 2026, in the week of Oct 26). Switched off they
// refuse before reading anything; on, the preview gives the engine's figures or a refusal as a
// category plus the one fixed line, and the proposal drafts exactly the engine's figures and
// refuses any field that differs.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const TUESDAY = new Date("2026-10-27T15:00:00Z");
const SENTENCE = "Starting Nov 2, owner-operator insurance goes to $12 a day";
const ASK: RuleChangeArgs = { ruleKey: "insurance_per_day_cents", newValue: 1_200, askedFrom: "2026-11-02" };
const ctx: GatewayContext = context({ now: TUESDAY, timeZone: zone, userText: SENTENCE });
const CAP = flags.gatewayLimits.ruleChangeImpactMaxCents;

const screenStore: Handler = (sql) => {
  if (sql.startsWith("SELECT verdict, CAST(categories AS text)")) return [];
  if (sql.startsWith("INSERT INTO screenings")) return 1;
  return undefined;
};
const complete: CompleteFn = async () =>
  ({
    callId: "c0ffee00-0000-4000-8000-000000000004",
    status: "ok",
    text: "VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99",
    toolCalls: [],
    usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  }) satisfies AiResult;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
const run = (name: string, args: unknown, over: Partial<GatewayContext> = {}) => {
  const db = planDb(plan, screenStore);
  return callTool({ ...ctx, ...over }, call(name, args), { db, clock: fixedClock, complete }).then((out) => ({
    out,
    db,
  }));
};

// The engine's own answer for the same ask on the same rows.
function engine(): RuleChange {
  const r = plan.rows;
  const check = ruleChangeOf(
    {
      tenant: { id: "t", slug: plan.carrier.slug, name: plan.carrier.name, timezone: zone },
      pay_configs: r.pay_configs,
      settlement_periods: r.settlement_periods,
      settlements: r.settlements,
      settlement_lines: r.settlement_lines,
      drivers: r.drivers,
      loads: r.loads,
      load_state_miles: r.load_state_miles,
      load_accessorials: r.load_accessorials,
      driver_days: r.driver_days,
      pay_items: r.pay_items,
      deduction_schedules: r.deduction_schedules,
      advances: r.advances,
    },
    ASK,
    { text: SENTENCE },
    TUESDAY,
  );
  if (!check.ok) throw new Error(`refused: ${check.reason}`);
  return check.change;
}

function proposeArgs(c: RuleChange, over: Record<string, unknown> = {}) {
  return {
    ...ASK,
    effectiveFrom: c.effectiveFrom,
    oldValue: c.oldValue,
    impactCents: c.impact.netDeltaCents,
    sourceRefs: [],
    ...over,
  };
}

afterEach(() => {
  flags.rulesByTalkingEnabled = false;
  flags.gatewayLimits.ruleChangeImpactMaxCents = CAP;
});

describe("pay rule change tools switched off", () => {
  it.each([
    ["preview_rule_change", ASK],
    [
      "propose_rule_change",
      { ...ASK, effectiveFrom: "2026-11-02", oldValue: 1_100, impactCents: -600, sourceRefs: [] },
    ],
  ])("%s refuses as disabled before reading a record, with one decision row", async (name, args) => {
    const { out, db } = await run(name, args);
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(db.decisions).toHaveLength(1);
    expect(db.decisions[0]).toMatchObject({ tool: name, decision: "blocked" });
    for (const st of db.statements) expect(st.sql).not.toMatch(/FROM (pay_configs|settlements|drivers|loads)\b/);
  });
});

describe("preview_rule_change", () => {
  it("gives the engine's figures for the person's sentence and changes nothing", async () => {
    flags.rulesByTalkingEnabled = true;
    const c = engine();
    const { out, db } = await run("preview_rule_change", ASK);
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toMatchObject({
      ok: true,
      ruleKey: "insurance_per_day_cents",
      title: "Owner-operator insurance: $11.00 to $12.00 per day",
      oldValue: 1_100,
      newValue: 1_200,
      askedFrom: "2026-11-02",
      effectiveFrom: "2026-11-02",
      starts: "Starts Monday, Nov 2",
      impactCents: c.impact.netDeltaCents,
      impact: { netDeltaCents: c.impact.netDeltaCents, line: impactLine(c.impact) },
    });
    expect(Number.isSafeInteger(c.impact.netDeltaCents)).toBe(true);
    expect(c.impact.netDeltaCents).toBeLessThan(0);
    expect(out.draft).toBeUndefined();
    for (const st of db.statements) expect(st.sql).not.toMatch(/^(INSERT INTO|UPDATE) (pay_configs|pay_rule_changes|proposals)\b/);
  });

  it.each([
    ["the value is not in the person's sentence", { ...ASK, newValue: 1_300 }, {}, "value_not_in_message"],
    ["there is no sentence outside a turn", ASK, { userText: null }, "value_not_in_message"],
    ["this week has begun", { ...ASK, askedFrom: "2026-10-26" }, { userText: "From Oct 26 insurance is $12 a day" }, "effective_in_past"],
    ["the value is already the rule", { ...ASK, newValue: 1_100 }, { userText: "insurance stays $11 a day from Nov 2" }, "no_change"],
  ] as const)("refuses when %s, as a category and the one fixed line", async (_why, args, over, category) => {
    flags.rulesByTalkingEnabled = true;
    const { out } = await run("preview_rule_change", args, over);
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toEqual({ ok: false, category, askBack: refusalLine(category) });
  });

  it("refuses a rule that is not one of the thirteen, and a fractional cent, as bad arguments", async () => {
    flags.rulesByTalkingEnabled = true;
    for (const args of [
      { ...ASK, ruleKey: "week_start_dow" },
      { ...ASK, ruleKey: "driver_rate_cents" },
      { ...ASK, newValue: 1_200.5 },
      { ...ASK, askedFrom: "Nov 2" },
    ]) {
      const { out } = await run("preview_rule_change", args);
      expect(out, JSON.stringify(args)).toMatchObject({ decision: "invalid_args" });
    }
  });

  it("is offered to neither the auditor nor triage", async () => {
    flags.rulesByTalkingEnabled = true;
    for (const role of ["auditor", "triage"] as const) {
      const { out } = await run("preview_rule_change", ASK, { role });
      expect(out, role).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
    }
  });
});

describe("propose_rule_change", () => {
  it("drafts exactly the engine's figures against the version in force", async () => {
    flags.rulesByTalkingEnabled = true;
    const c = engine();
    const { out, db } = await run("propose_rule_change", proposeArgs(c));
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.draft).toMatchObject({
      kind: "pay_rule_change",
      subjectTable: "pay_configs",
      subjectId: c.baseVersionId,
      amountCents: c.impact.netDeltaCents,
      args: changeArgsOf(c),
      limitCents: CAP,
      reasons: ["rule_change_sized_by_engine"],
    });
    expect(out.result).toMatchObject({
      proposed: true,
      kind: "pay_rule_change",
      effectiveFrom: "2026-11-02",
      impactCents: c.impact.netDeltaCents,
    });
    expect(db.decisions).toHaveLength(1);
  });

  it.each([
    ["a weekly impact the engine did not compute", { impactCents: -500 }],
    ["a start date the engine did not give", { effectiveFrom: "2026-11-09" }],
    ["an old value that is not the rule", { oldValue: 1_000 }],
  ])("refuses %s, with one decision row", async (_why, over) => {
    flags.rulesByTalkingEnabled = true;
    const { out, db } = await run("propose_rule_change", proposeArgs(engine(), over));
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
    expect(db.decisions).toHaveLength(1);
  });

  it("refuses an impact over the cap, and takes one exactly at it", async () => {
    flags.rulesByTalkingEnabled = true;
    const c = engine();
    const size = Math.abs(c.impact.netDeltaCents);
    flags.gatewayLimits.ruleChangeImpactMaxCents = size - 1;
    const over = await run("propose_rule_change", proposeArgs(c));
    expect(over.out).toMatchObject({ decision: "blocked", reason: "amount_over_limit" });
    flags.gatewayLimits.ruleChangeImpactMaxCents = size;
    const at = await run("propose_rule_change", proposeArgs(c));
    expect(at.out).toMatchObject({ decision: "allowed" });
  });

  it("refuses when the value is not in the person's sentence", async () => {
    flags.rulesByTalkingEnabled = true;
    const { out } = await run("propose_rule_change", proposeArgs(engine()), { userText: "make insurance higher" });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
  });

  it("is never offered to the auditor", async () => {
    flags.rulesByTalkingEnabled = true;
    const { out } = await run("propose_rule_change", proposeArgs(engine()), { role: "auditor" });
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});

describe("a pay rule change card's amount", () => {
  it("is the size of the weekly change, out when pay goes up, in when it goes down, none when it stays", () => {
    expect(impactOf("pay_rule_change", 2_400)).toEqual({ amountCents: 2_400, direction: "out" });
    expect(impactOf("pay_rule_change", -2_400)).toEqual({ amountCents: 2_400, direction: "in" });
    expect(impactOf("pay_rule_change", 0)).toEqual({ amountCents: 0, direction: "none" });
    expect(PROPOSAL_TITLES.pay_rule_change).toBe("Change a pay rule");
  });
});
