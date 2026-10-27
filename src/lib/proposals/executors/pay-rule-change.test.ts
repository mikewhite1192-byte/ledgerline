import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import { SESSION, TENANT, type Handler, type Row } from "../../agent/gateway/__tests__/fake-db";
import { blueRidgePlan, planDb } from "../../agent/gateway/__tests__/plan-db";
import { changeArgsOf, ruleChangeOf, type RuleChange } from "../../pay-rules/change";
import type { ProposalRow } from "../execute";
import { executePayRuleChange } from "./pay-rule-change";

// The pay rule change executor's refusals, on the synthetic seed plan through the real readers and
// the real rules engine with no database. The switch off or another kind refuses before anything is
// read; a missing, finished or decided proposal writes nothing; args that do not parse fail it as
// not_executable; any difference from what the engine says now fails it as stale. Every failure
// writes the proposal's own move to failed and nothing else. The write path runs on a real
// database in pay-rule-change.db.test.ts.

const plan = blueRidgePlan();
const TUESDAY = new Date("2026-10-27T15:00:00Z");
const ID = "77777777-7777-4777-8777-777777777777";
const ASK = { ruleKey: "insurance_per_day_cents", newValue: 1_200, askedFrom: "2026-11-02" };

function engine(): RuleChange {
  const r = plan.rows;
  const check = ruleChangeOf(
    {
      tenant: { id: TENANT, slug: plan.carrier.slug, name: plan.carrier.name, timezone: plan.carrier.timezone },
      pay_configs: r.pay_configs,
      settlement_periods: r.settlement_periods,
      settlements: r.settlements,
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
    "skip",
    TUESDAY,
  );
  if (!check.ok) throw new Error(`refused: ${check.reason}`);
  return check.change;
}

const change = engine();
const ARGS = changeArgsOf(change);
const AMOUNT = Math.abs(change.impact.netDeltaCents);

type Locked = { status: string; amount_cents: number; args: string } | null;

// The plan's rows plus the executor's own statements: the proposal lock answers the scripted row,
// the version lock and the advisory lock answer as Postgres would, and the move to failed counts
// one row.
function dbFor(locked: Locked) {
  const extra: Handler = (sql) => {
    if (sql.includes("FROM proposals") && sql.includes("FOR UPDATE")) return locked ? [{ ...locked } as Row] : [];
    if (sql === "SELECT id FROM pay_configs WHERE tenant_id = current_tenant_id() FOR UPDATE") return [];
    if (sql.includes("pg_advisory_xact_lock")) return [{ ok: 1 }];
    if (sql.trimStart().startsWith("UPDATE proposals SET status = 'failed'")) return 1;
    return undefined;
  };
  return planDb(plan, extra);
}

function proposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: ID,
    conversationId: "c1",
    turnId: "t1",
    kind: "pay_rule_change",
    subjectTable: "pay_configs",
    subjectId: change.baseVersionId,
    amountCents: AMOUNT,
    direction: "none",
    args: {},
    status: "approved",
    flaggedInputId: null,
    auditorVerdict: "pass",
    auditorAgrees: true,
    moneyActionId: null,
    traceId: "trace-1",
    ...over,
  };
}

const run = (db: ReturnType<typeof dbFor>, p = proposal(), at = TUESDAY) =>
  executePayRuleChange(db, SESSION, p, { confirmed: false }, { clock: () => at });

const writes = (db: ReturnType<typeof dbFor>) =>
  db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(s.sql)).map((s) => ({ sql: s.sql.trim(), params: s.params }));

// The only write a refusal makes: the proposal's own move to failed, with its category.
function onlyFailed(db: ReturnType<typeof dbFor>, category: string, at = TUESDAY) {
  const w = writes(db);
  expect(w).toHaveLength(1);
  expect(w[0].sql).toMatch(/^UPDATE proposals SET status = 'failed'/);
  expect(w[0].sql).toContain("status IN ('approved', 'executing')");
  expect(w[0].params).toEqual([ID, category, at.toISOString()]);
}

const stored = (args: unknown, over: Partial<NonNullable<Locked>> = {}): Locked => ({
  status: "approved",
  amount_cents: AMOUNT,
  args: JSON.stringify(args),
  ...over,
});

afterEach(() => {
  flags.rulesByTalkingEnabled = false;
  vi.restoreAllMocks();
});

describe("executePayRuleChange", () => {
  it("refuses with the switch off, or for another kind, before reading anything", async () => {
    const off = dbFor(stored(ARGS));
    expect(await run(off)).toEqual({ ok: false, category: "not_executable", retryable: false });
    expect(off.statements).toEqual([]);
    expect(off.transactions).toBe(0);

    flags.rulesByTalkingEnabled = true;
    const other = dbFor(stored(ARGS));
    expect(await run(other, proposal({ kind: "pay_correction" }))).toEqual({
      ok: false,
      category: "not_executable",
      retryable: false,
    });
    expect(other.statements).toEqual([]);
  });

  it("writes nothing for a proposal it cannot find, one already done, or one already decided", async () => {
    flags.rulesByTalkingEnabled = true;
    const missing = dbFor(null);
    expect(await run(missing)).toEqual({ ok: false, category: "not_found", retryable: false });
    expect(missing.statements).toHaveLength(1);

    const done = dbFor(stored(ARGS, { status: "done" }));
    expect(await run(done)).toEqual({ ok: true, proposalId: ID, status: "done", moneyActionId: null });
    expect(done.statements).toHaveLength(1);

    for (const status of ["proposed", "rejected", "failed", "expired"]) {
      const db = dbFor(stored(ARGS, { status }));
      expect(await run(db), status).toEqual({ ok: false, category: "already_decided", retryable: false });
      expect(db.statements, status).toHaveLength(1);
    }
  });

  it.each([
    ["args that are not JSON", "{"],
    ["args with a field the schema does not know", { ...ARGS, note: "x" }],
    ["args with a fractional cent", { ...ARGS, newValue: 1_200.5 }],
    ["args naming another version than the proposal's subject", { ...ARGS, baseVersionId: ID }],
  ])("fails as not_executable on %s, before any rule is read", async (_why, args) => {
    flags.rulesByTalkingEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = dbFor(typeof args === "string" ? { status: "approved", amount_cents: AMOUNT, args } : stored(args));
    expect(await run(db)).toEqual({ ok: false, category: "not_executable", retryable: false });
    onlyFailed(db, "not_executable");
    expect(db.statements.some((s) => s.sql.includes("FROM pay_configs"))).toBe(false);
  });

  it("goes on to the write when the stored figures are the engine's now (the control for the stale cases)", async () => {
    flags.rulesByTalkingEnabled = true;
    const db = dbFor(stored(ARGS));
    // The scripted database has no catalog, so the run stops at the first read the write needs.
    await expect(run(db)).rejects.toThrow(/unexpected statement: SELECT column_name/);
    expect(writes(db)).toEqual([]);
  });

  it.each([
    ["a weekly impact the engine does not compute now", stored({ ...ARGS, impact: { ...ARGS.impact, netDeltaCents: -1 } }), TUESDAY],
    ["an old value that is not the rule now", stored({ ...ARGS, oldValue: 1_000 }), TUESDAY],
    ["a start date the engine does not give", stored({ ...ARGS, effectiveFrom: "2026-11-09" }), TUESDAY],
    ["a stored amount that is not the impact's size", stored(ARGS, { amount_cents: AMOUNT + 1 }), TUESDAY],
    ["a week that began before the approval", stored(ARGS), new Date("2026-11-02T15:00:00Z")],
  ])("fails as stale on %s, writing only the proposal's failure", async (_why, locked, at) => {
    flags.rulesByTalkingEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = dbFor(locked);
    expect(await run(db, proposal(), at)).toEqual({ ok: false, category: "stale", retryable: false });
    onlyFailed(db, "stale", at);
    // The versions were locked and read before the engine sized it again.
    expect(db.statements.some((s) => s.sql.endsWith("FOR UPDATE") && s.sql.includes("FROM pay_configs"))).toBe(true);
  });
});
