import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import type { PeriodOption } from "./list";
import { pickPeriod, readSettlementsView } from "./views";

// Which pay week the Settlements page opens on. With no week asked it opens on the newest week that
// has paystubs, so a new week with none yet does not hide last week's; with none anywhere, the
// newest open week as before. Home and Needs you keep reading the open week.

const NEW_WEEK = "11111111-1111-4111-8111-000000000003";
const THIS_WEEK = "11111111-1111-4111-8111-000000000002";
const PAID_WEEK = "11111111-1111-4111-8111-000000000001";
const PERIODS: PeriodOption[] = [
  { id: NEW_WEEK, start: "2026-11-02", end: "2026-11-08", status: "open" },
  { id: THIS_WEEK, start: "2026-10-26", end: "2026-11-01", status: "open" },
  { id: PAID_WEEK, start: "2026-10-19", end: "2026-10-25", status: "paid" },
];

describe("pickPeriod", () => {
  it("opens the newest week with paystubs, not the newest empty week", () => {
    expect(pickPeriod(PERIODS, null, new Set([THIS_WEEK, PAID_WEEK]))?.id).toBe(THIS_WEEK);
    expect(pickPeriod(PERIODS, null, new Set([PAID_WEEK]))?.id).toBe(PAID_WEEK);
  });

  it("falls back to the newest open week when no week has paystubs, or when it was not asked to look", () => {
    expect(pickPeriod(PERIODS, null, new Set())?.id).toBe(NEW_WEEK);
    expect(pickPeriod(PERIODS, null, null)?.id).toBe(NEW_WEEK);
    expect(pickPeriod([PERIODS[2]], null, new Set())?.id).toBe(PAID_WEEK);
    expect(pickPeriod([], null, new Set())).toBeNull();
  });

  it("opens the week asked for when it is listed, with or without paystubs", () => {
    expect(pickPeriod(PERIODS, NEW_WEEK, new Set([PAID_WEEK]))?.id).toBe(NEW_WEEK);
    expect(pickPeriod(PERIODS, "11111111-1111-4111-8111-000000000099", new Set([PAID_WEEK]))?.id).toBe(PAID_WEEK);
  });
});

describe("readSettlementsView", () => {
  // Answers each read by its SQL; the paystub rows and the clean set are empty.
  function fakeQ(withStubs: string[]) {
    const seen: string[] = [];
    const q = {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        if (/FROM settlement_periods/.test(sql) && !/JOIN/.test(sql)) {
          seen.push("periods");
          return PERIODS.map((p) => ({ id: p.id, period_start: p.start, period_end: p.end, status: p.status })) as T[];
        }
        if (/SELECT DISTINCT CAST\(period_id AS text\)/.test(sql)) {
          seen.push("stubs");
          return withStubs.map((period_id) => ({ period_id })) as T[];
        }
        if (/own_insurance/.test(sql)) return [];
        if (/FROM settlements s/.test(sql) || /FROM proposals p/.test(sql)) {
          seen.push(`rows ${String(params?.[0])}`);
          return [];
        }
        throw new Error(`unexpected read: ${sql.slice(0, 80)}`);
      },
      async execute() {
        throw new Error("the view writes nothing");
      },
    } as Queryable;
    return { q, seen };
  }

  it("on the Settlements page with no week asked, reads which weeks have paystubs and opens the newest of them", async () => {
    const { q, seen } = fakeQ([PAID_WEEK, THIS_WEEK]);
    const view = await readSettlementsView(q, null, { newestWithStubs: true });
    expect(view.period?.id).toBe(THIS_WEEK);
    expect(seen).toContain("stubs");
    expect(seen.filter((s) => s.startsWith("rows")).every((s) => s === `rows ${THIS_WEEK}`)).toBe(true);
  });

  it("opens the newest open week when no week has paystubs", async () => {
    const { q } = fakeQ([]);
    expect((await readSettlementsView(q, null, { newestWithStubs: true })).period?.id).toBe(NEW_WEEK);
  });

  it("keeps the open week for Home and Needs you, and never reads the paystub weeks then or for a listed asked week", async () => {
    const home = fakeQ([PAID_WEEK]);
    expect((await readSettlementsView(home.q, null)).period?.id).toBe(NEW_WEEK);
    expect(home.seen).not.toContain("stubs");
    const asked = fakeQ([PAID_WEEK]);
    expect((await readSettlementsView(asked.q, NEW_WEEK, { newestWithStubs: true })).period?.id).toBe(NEW_WEEK);
    expect(asked.seen).not.toContain("stubs");
  });
});
