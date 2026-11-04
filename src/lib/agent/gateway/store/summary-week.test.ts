import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Param } from "@/lib/db";
import { SESSION, TENANT } from "../__tests__/fake-db";
import { blueRidgePlan, planDb } from "../__tests__/plan-db";
import { openAgentTurn } from "./index";
import { buildStateSummary, paidNextLine, payWeekLine } from "./summary";

// The week paid next in the agent's summary: the week the pay check and the sweep read, named on
// its own line so "this week" in a pay question means it, not the calendar week the roll opens
// empty. Read once per operator question, beside the carrier notes, in its own transaction.

const CONVERSATION = "55555555-5555-4555-8555-555555555555";
// Tuesday Nov 3, 2026, mid-day in the carrier's zone: today's week is Nov 2 to Nov 8.
const NOW = new Date("2026-11-03T17:00:00Z");
const CAP = 10_000;
const plan = blueRidgePlan();
const due = plan.rows.settlement_periods.find((p) => p.status === "open")!;
const PAID_NEXT = { id: due.id, start: due.period_start, end: due.period_end };
const LINE =
  `Week paid next (the pay check's week): Oct 26 to Nov 1, 2026, periodId ${due.id}; ` +
  `read "this week" in a pay question as the week paid next`;

const savedMemory = flags.carrierMemoryEnabled;
afterEach(() => {
  flags.carrierMemoryEnabled = savedMemory;
  vi.restoreAllMocks();
});

// The conversation reads the summary makes, and the turn's own writes, all empty or counted.
function turnStatements(sql: string, params: Param[]) {
  if (sql === "SELECT id FROM turns WHERE id = CAST($1 AS uuid)") return [];
  if (sql.startsWith("SELECT subject_table, subject_id FROM conversations")) return [];
  if (sql.includes("FROM turns t") || sql.includes("FROM proposals p") || sql.includes("FROM gateway_decisions g")) return [];
  if (sql.includes("FROM carrier_notes")) return [];
  if (sql.includes("COALESCE(MAX(seq), 0) + 1")) return [{ seq: 1 }];
  if (sql.startsWith("INSERT INTO conversations") || sql.startsWith("INSERT INTO turns") || sql.startsWith("UPDATE conversations")) {
    return params.length > 0 ? 1 : 0;
  }
  return undefined;
}

describe("the pay week and week paid next lines", () => {
  const week = { start: "2026-11-02", end: "2026-11-08" };

  it("are today's line exactly, and no week paid next, when it was not read or no week is open", () => {
    const today = "Pay week: Monday to Sunday, this week 2026-11-02 to 2026-11-08";
    expect(payWeekLine(1, week, undefined)).toBe(today);
    expect(payWeekLine(1, week, null)).toBe(today);
    expect(paidNextLine(undefined)).toBeNull();
    expect(paidNextLine(null)).toBeNull();
  });

  it("name today's week and the week paid next, and read this week as the week paid next", () => {
    expect(payWeekLine(1, week, PAID_NEXT)).toBe("Pay week: Monday to Sunday, today's week 2026-11-02 to 2026-11-08");
    expect(paidNextLine(PAID_NEXT)).toBe(LINE);
  });

  it("say the week paid next is not available when its read failed or its dates do not read, and claim no week", () => {
    expect(paidNextLine("unavailable")).toBe("Week paid next: not available");
    expect(paidNextLine({ ...PAID_NEXT, end: "Nov 1" })).toBe("Week paid next: not available");
  });
});

describe("the summary's week paid next", () => {
  it("rides whole at the end of the Carrier section, after the pay week, and Today stays as is", async () => {
    const db = planDb(plan, turnStatements);
    const out = await db.withTenant(TENANT, (q) =>
      buildStateSummary(q, SESSION, CONVERSATION, NOW, CAP, "", [], null, PAID_NEXT),
    );
    const carrier = out.text.split("\n\n").find((s) => s.startsWith("Carrier:"))!;
    expect(carrier).toContain("\nToday: 2026-11-03\n");
    expect(carrier.endsWith(`\nPay week: Monday to Sunday, today's week 2026-11-02 to 2026-11-08\n${LINE}`)).toBe(true);
  });

  it("follows the pay week line on the week's first day", async () => {
    const db = planDb(plan, turnStatements);
    const monday = new Date("2026-11-02T17:00:00Z");
    const out = await db.withTenant(TENANT, (q) =>
      buildStateSummary(q, SESSION, CONVERSATION, monday, CAP, "", [], null, PAID_NEXT),
    );
    expect(out.text).toContain(`\nPay week: Monday to Sunday, today's week 2026-11-02 to 2026-11-08\n${LINE}\n\nPay rules:`);
  });

  it("is left out for a turn that did not read it, whose pay week line is today's", async () => {
    const db = planDb(plan, turnStatements);
    const monday = new Date("2026-11-02T17:00:00Z");
    const out = await db.withTenant(TENANT, (q) => buildStateSummary(q, SESSION, CONVERSATION, monday, CAP));
    expect(out.text).toContain("Pay week: Monday to Sunday, this week 2026-11-02 to 2026-11-08");
    expect(out.text).not.toContain("Week paid next");
  });
});

describe("openAgentTurn and the week paid next", () => {
  it("reads it once, in its own transaction beside the notes, for an operator's own question", async () => {
    flags.carrierMemoryEnabled = true;
    const db = planDb(plan, turnStatements);
    const opened = await openAgentTurn(
      SESSION,
      { conversationId: null, turnId: "66666666-6666-4666-8666-666666666666", text: "Why is pay short this week?", now: NOW, summaryChars: CAP, readNotes: true },
      { db, clock: () => NOW },
    );
    if ("refused" in opened) throw new Error(`refused ${opened.refused}`);
    expect(opened.summary).toContain(LINE);
    // The notes, the week paid next and the turn: three transactions, the periods read once.
    expect(db.transactions).toBe(3);
    expect(db.statements.filter((s) => /FROM settlement_periods WHERE tenant_id/.test(s.sql))).toHaveLength(1);
  });

  it("says not available, with the turn id only in the log, when the read fails", async () => {
    flags.carrierMemoryEnabled = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = planDb(plan, (sql, params) => {
      if (sql.includes("FROM driver_days")) throw new Error("connection reset by peer at 10.0.0.7");
      return turnStatements(sql, params);
    });
    const opened = await openAgentTurn(
      SESSION,
      { conversationId: null, turnId: "77777777-7777-4777-8777-777777777777", text: "Why is pay short this week?", now: NOW, summaryChars: CAP, readNotes: true },
      { db, clock: () => NOW },
    );
    if ("refused" in opened) throw new Error(`refused ${opened.refused}`);
    expect(opened.summary).toContain("Week paid next: not available");
    expect(opened.summary).not.toContain("10.0.0.7");
    expect(log).toHaveBeenCalledWith("summary: week paid next unreadable for turn 77777777-7777-4777-8777-777777777777");
  });

  it("reads nothing for a turn that does not read the notes", async () => {
    const db = planDb(plan, turnStatements);
    const opened = await openAgentTurn(
      SESSION,
      { conversationId: null, turnId: "88888888-8888-4888-8888-888888888888", text: "check", now: NOW, summaryChars: CAP },
      { db, clock: () => NOW },
    );
    if ("refused" in opened) throw new Error(`refused ${opened.refused}`);
    expect(opened.summary).not.toContain("Week paid next");
    expect(db.transactions).toBe(1);
    expect(db.statements.some((s) => /FROM settlement_periods WHERE tenant_id/.test(s.sql))).toBe(false);
  });
});
