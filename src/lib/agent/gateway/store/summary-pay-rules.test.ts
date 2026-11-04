import { describe, expect, it } from "vitest";
import { SESSION, TENANT } from "../__tests__/fake-db";
import { blueRidgePlan, planDb } from "../__tests__/plan-db";
import { buildStateSummary } from "./summary";

// The summary's pay rules come from the version of the week holding today, on every day of the
// week. They were read with today as a period start, which only the week's first day is, so six
// days of seven the summary said "Pay rules: not available" and had no pay week line.

const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const CAP = 10_000;
const plan = blueRidgePlan();

function conversationReads(sql: string) {
  if (sql.startsWith("SELECT subject_table, subject_id FROM conversations")) return [];
  if (sql.includes("FROM turns t") || sql.includes("FROM proposals p") || sql.includes("FROM gateway_decisions g")) return [];
  return undefined;
}

async function summaryAt(iso: string): Promise<string> {
  const out = await planDb(plan, conversationReads).withTenant(TENANT, (q) =>
    buildStateSummary(q, SESSION, CONVERSATION, new Date(iso), CAP),
  );
  return out.text;
}

describe("the summary's pay rules", () => {
  // Noon in the carrier's zone (America/New_York), each day of the week of Nov 2, 2026.
  const days = [
    ["Monday", "2026-11-02T17:00:00Z"],
    ["Tuesday", "2026-11-03T17:00:00Z"],
    ["Wednesday", "2026-11-04T17:00:00Z"],
    ["Saturday", "2026-11-07T17:00:00Z"],
    ["Sunday", "2026-11-08T17:00:00Z"],
  ] as const;

  it.each(days)("read on a %s, with the week holding today", async (_day, iso) => {
    const text = await summaryAt(iso);
    expect(text).not.toContain("Pay rules: not available");
    expect(text).toContain("Pay week: Monday to Sunday, this week 2026-11-02 to 2026-11-08");
    expect(text).toMatch(/\nPay rules:\nAdvance fee: \$\d+\.\d{2}\n/);
  });

  it("say not available when the carrier has no pay rules", async () => {
    const none = { ...plan, rows: { ...plan.rows, pay_configs: [] } };
    const out = await planDb(none, conversationReads).withTenant(TENANT, (q) =>
      buildStateSummary(q, SESSION, CONVERSATION, new Date("2026-11-03T17:00:00Z"), CAP),
    );
    expect(out.text).toContain("Pay rules: not available");
    expect(out.text).not.toContain("Pay week:");
  });
});
