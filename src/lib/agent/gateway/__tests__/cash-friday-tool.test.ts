import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { instantAt } from "../../../seed/calendar";
import { summarizePlan } from "../../../seed/summary";
import { TEST_SHORT_CENTS } from "../../../seed/test-short-friday.test-util";
import { CASH_PROMPT, CHECKLIST_RULE, OPERATOR_PROMPT, operatorPrompt } from "../../policy";
import { callTool, MAX_RESULT_CHARS } from "../index";
import { toolsFor } from "../registry";
import { centsIn, maskFigures } from "../../operator/figures";
import { CASH_LINES_MAX, cashFridaySummary, getCashFriday } from "../tools/read/get-cash-friday";
import type { GatewayContext } from "../types";
import { context, fixedClock, type Handler } from "./fake-db";
import { PLAN_ANCHOR, planDb, shortFridayPlan } from "./plan-db";

// get_cash_friday over the synthetic Blue Ridge plan at the golden anchor, its bank balance lowered
// so Friday is short and the engine has moves to find: the engine's figures to
// the cent, the moves it found, the latest stored check and the open cards, inside the gateway's
// size cap. It creates nothing. No database, no clock, no network.

const plan = shortFridayPlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(PLAN_ANCHOR, 12, 0, zone)), timeZone: zone });
const CHECK = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const CARD = "7c2d0e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";

const LATEST_CHECK = /^SELECT CAST\(id AS text\) AS id, CAST\(created_at AS text\) AS created_at\s+FROM cash_checks /;
const OPEN_CARDS = /^SELECT CAST\(id AS text\) AS id, kind, status\s+FROM proposals\s+WHERE tenant_id = current_tenant_id\(\) AND origin = 'engine'/;

const stored: Handler = (sql) => {
  if (LATEST_CHECK.test(sql)) return [{ id: CHECK, created_at: "2026-11-02 17:00:00+00" }];
  if (OPEN_CARDS.test(sql)) return [{ id: CARD, kind: "bill_defer", status: "proposed" }];
  return undefined;
};

const call = { id: "call-1", name: "get_cash_friday", argumentsJson: "{}" };

const dollars = (cents: number) =>
  `$${Math.trunc(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

const shipped = structuredClone(flags);

afterEach(() => {
  Object.assign(flags, structuredClone(shipped));
});

describe("get_cash_friday", () => {
  it("returns the engine's position, the moves, the latest check and the open cards, and writes nothing", async () => {
    flags.cashFridayEnabled = true;
    const db = planDb(plan, stored);
    const out = await callTool(ctx, call, { db, clock: fixedClock });
    expect(out).toMatchObject({ decision: "allowed" });
    if (out.decision !== "allowed") throw new Error("not allowed");
    const r = out.result as Record<string, unknown> & { figures: Record<string, number>; rows: unknown[] };
    const want = summarizePlan(plan).cashFriday;
    // The figures below are the plan's own, so first pin that the plan is short by the test's amount.
    expect(want.gapCents).toBe(-TEST_SHORT_CENTS);
    expect(r.payDay).toBe(want.payDay);
    expect(r.figures).toMatchObject({
      bankBalanceCents: want.bankBalanceCents,
      cashOnHandCents: want.cashOnHandCents,
      expectedReceiptsCents: want.expectedReceiptsCents,
      payRunCents: want.payRunCents,
      vendorBillsDueCents: want.vendorBillsDueCents,
      gapCents: want.gapCents,
    });
    expect(r.payRunSource).toBe(want.payRunSource);
    // The two sides of the gap, summed by the server so a covered or short answer quotes them.
    expect(r.cashByPayDayCents).toBe(want.cashOnHandCents + want.expectedReceiptsCents);
    expect(r.dueByPayDayCents).toBe(r.figures.payRunCents + r.figures.fuelLoadsCents + want.vendorBillsDueCents);
    expect((r.cashByPayDayCents as number) - (r.dueByPayDayCents as number)).toBe(want.gapCents);
    // What is due besides the pay run, so "the pay run plus X" quotes X: an answer quoting it and
    // each side stays verified, and the difference the model would work out alone is withheld.
    expect(r.fuelAndBillsDueCents).toBe(r.figures.fuelLoadsCents + want.vendorBillsDueCents);
    const allowed = centsIn(out.result);
    const answer = `Against a ${dollars(want.payRunCents)} pay run plus ${dollars(r.fuelAndBillsDueCents as number)} in fuel loads and bills due.`;
    expect(maskFigures(answer, allowed)).toEqual({ text: answer, masked: 0 });
    // The summary is written from the result's own figures, so read as it is, it stays verified.
    expect(r.summary).toBe(
      cashFridaySummary({
        payDay: r.payDay as string,
        gapCents: want.gapCents,
        cashByPayDayCents: r.cashByPayDayCents as number,
        dueByPayDayCents: r.dueByPayDayCents as number,
        payRunCents: r.figures.payRunCents,
        fuelAndBillsDueCents: r.fuelAndBillsDueCents as number,
      }),
    );
    expect(maskFigures(r.summary as string, allowed)).toEqual({ text: r.summary, masked: 0 });
    expect(getCashFriday.description).toContain("summary is one sentence written from those figures");
    expect(getCashFriday.description).toContain("never add, subtract or round figures yourself");
    const options = r.options as { kind: string; billRef?: string }[];
    expect(options.map((o) => o.kind).sort()).toEqual([
      "bill_defer",
      "collections_chase",
      "collections_chase",
      "factoring_request",
    ]);
    expect(options.find((o) => o.kind === "bill_defer")?.billRef).toBe(want.deferBillRef);
    // Each option's own engine figures, under Cents names the answer's check reads.
    for (const o of options as Record<string, unknown>[]) {
      if (o.kind === "factoring_request") expect(o).toEqual(expect.objectContaining({ balanceCents: expect.any(Number), advanceCents: expect.any(Number) }));
      if (o.kind === "collections_chase") expect(typeof o.newCashCents).toBe("number");
    }
    expect(r.latestCheckId).toBe(CHECK);
    expect(r.openCards).toEqual([{ proposalId: CARD, kind: "bill_defer", status: "proposed" }]);
    expect(r.rows.length).toBeLessThanOrEqual(CASH_LINES_MAX);
    expect(r.linesTotal).toBeGreaterThanOrEqual(r.rows.length);
    expect(JSON.stringify(out.result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    // Reads only: no statement but SELECTs and the gateway's own decision row.
    const writes = db.statements.filter(
      (s) => !/^\s*SELECT/i.test(s.sql) && !s.sql.startsWith("INSERT INTO gateway_decisions"),
    );
    expect(writes).toEqual([]);
  });

  it("is neither offered nor run while its switch is off", async () => {
    flags.cashFridayEnabled = false;
    expect(toolsFor("operator").map((t) => t.name)).not.toContain("get_cash_friday");
    const db = planDb(plan, stored);
    const out = await callTool(ctx, call, { db, clock: fixedClock });
    expect(out.decision).not.toBe("allowed");
    expect(db.statements.some((s) => s.sql.includes("cash_checks") || s.sql.includes("vendor_bills"))).toBe(false);
  });

  it("adds its prompt lines only while it is offered, so the switched-off prompt is unchanged", () => {
    // The other switches that add prompt lines are off too, so the base prompt is the whole of it.
    Object.assign(flags, {
      cashFridayEnabled: false,
      collectionsEnabled: false,
      reportsEnabled: false,
      carrierMemoryEnabled: false,
      moneyCodes: { ...flags.moneyCodes, enabled: false },
      escrowRelease: { ...flags.escrowRelease, enabled: false },
    });
    const off = toolsFor("operator").map((t) => t.name);
    expect(operatorPrompt(off, false)).toBe(`${OPERATOR_PROMPT}\n${CHECKLIST_RULE}`);
    flags.cashFridayEnabled = true;
    const on = toolsFor("operator").map((t) => t.name);
    expect(operatorPrompt(on, false)).toBe(`${OPERATOR_PROMPT}\n${CASH_PROMPT}\n${CHECKLIST_RULE}`);
  });
});

describe("cashFridaySummary", () => {
  const figures = { payDay: "2026-11-06", cashByPayDayCents: 13_694_457, dueByPayDayCents: 11_022_091, payRunCents: 2_793_344, fuelAndBillsDueCents: 8_228_747 };

  it("says covered by the gap and names both sides, to the cent", () => {
    expect(cashFridaySummary({ ...figures, gapCents: 2_672_366 })).toBe(
      "Covered by $26,723.66 for pay day Nov 6, 2026. What comes in by pay day is $136,944.57 and what goes out " +
        "is $110,220.91: the pay run of $27,933.44 plus $82,287.47 in fuel loads and bills due.",
    );
  });

  it("says short by the gap without a minus sign, and a zero gap reads covered", () => {
    expect(cashFridaySummary({ ...figures, gapCents: -50_000 })).toMatch(/^Short by \$500\.00 for pay day Nov 6, 2026\. /);
    expect(cashFridaySummary({ ...figures, gapCents: 0 })).toMatch(/^Covered by \$0\.00 for pay day/);
  });
});
