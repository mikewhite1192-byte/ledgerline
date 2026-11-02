import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { recordHref } from "../records/href";
import { readHeroLink } from "./hero-link";
import { HERO_DRIVER } from "./hero-week";

// The help page's paystub link with two open weeks (D-090): the newest open week with a stub for
// the worked week's driver wins, an older one when the newer has none, else her driver page.

const heroId = randomUUID();
const older = { id: randomUUID(), period_start: "2026-10-26", period_end: "2026-11-01", status: "open" };
const newer = { id: randomUUID(), period_start: "2026-11-02", period_end: "2026-11-08", status: "open" };

// A stand-in for the three tables the link reads, answered by the table the SQL names.
function heroDb(stubs: { id: string; period_id: string }[]): Queryable {
  return {
    async query<T>(sql: string): Promise<T[]> {
      if (/FROM drivers /.test(sql)) return [{ id: heroId, code: HERO_DRIVER.code }] as T[];
      if (/FROM settlement_periods /.test(sql)) return [older, newer] as T[];
      if (/FROM settlements /.test(sql)) return stubs.map((s) => ({ ...s, driver_id: heroId })) as T[];
      throw new Error("unexpected read");
    },
    async execute() {
      throw new Error("the link writes nothing");
    },
  };
}

describe("readHeroLink with two open weeks", () => {
  it("picks the newest open week's stub", async () => {
    const oldStub = { id: randomUUID(), period_id: older.id };
    const newStub = { id: randomUUID(), period_id: newer.id };
    expect(await readHeroLink(heroDb([oldStub, newStub]))).toEqual({
      href: recordHref({ table: "settlements", id: newStub.id }),
      draft: true,
    });
  });

  it("falls back to the older open week when the newer has no stub yet", async () => {
    const oldStub = { id: randomUUID(), period_id: older.id };
    expect(await readHeroLink(heroDb([oldStub]))).toEqual({
      href: recordHref({ table: "settlements", id: oldStub.id }),
      draft: true,
    });
  });

  it("sends her driver page when no open week has her stub", async () => {
    expect(await readHeroLink(heroDb([]))).toEqual({ href: recordHref({ table: "drivers", id: heroId }), draft: false });
  });
});
