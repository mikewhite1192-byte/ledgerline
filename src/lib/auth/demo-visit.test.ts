import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { atHome, chargeVisit, countVisitTurn, ipHashOf, readVisit, settleVisit, startVisit } from "./demo-visit";

// The guards that run before any SQL, and the fail-closed answers to rows that cannot be right.
// The SQL itself is proven against a real database in demo-visit.db.test.ts.

const LIMITS = {
  sessionCapCents: 100,
  turnsPerSession: 25,
  dayCapCents: 800,
  sessionsPerIpPerHour: 5,
  sessionsPerHour: 40,
  sessionsPerDay: 150,
  cookieHours: 2,
};
const VISIT = "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c1a90";

function fakeQ(answer: { rows?: unknown[]; affected?: number } = {}) {
  const calls: string[] = [];
  const q = {
    query: async (sql: string) => {
      calls.push(sql);
      return answer.rows ?? [];
    },
    execute: async (sql: string) => {
      calls.push(sql);
      return answer.affected ?? 0;
    },
  } as unknown as Queryable;
  return { q, calls };
}

describe("ipHashOf", () => {
  it("hashes the first forwarded address, the same one the same way, never as written", () => {
    const one = ipHashOf("203.0.113.7, 10.0.0.1");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(ipHashOf(" 203.0.113.7 ")).toBe(one);
    expect(ipHashOf("203.0.113.8")).not.toBe(one);
    expect(ipHashOf("2001:DB8::1")).toBe(ipHashOf("2001:db8::1"));
    expect(one).not.toContain("203.0.113.7");
  });

  it("is no address for a missing or malformed header", () => {
    for (const header of [null, undefined, "", " , 10.0.0.1", "unknown", "<script>", "1".repeat(46)]) {
      expect(ipHashOf(header)).toBeNull();
    }
  });
});

describe("demo visit guards", () => {
  it("reads nothing for a cookie that is not a visit id", async () => {
    const { q, calls } = fakeQ({ rows: [{ role: "judge", live: true }] });
    await expect(readVisit(q, "sub-1", "not-a-visit")).resolves.toEqual({ role: null, live: false, copy: null });
    expect(calls).toEqual([]);
  });

  it("reads no role from no row, two rows or an unknown role", async () => {
    for (const rows of [[], [{ role: "judge", live: true }, { role: "judge", live: true }], [{ role: "owner", live: true }]]) {
      await expect(readVisit(fakeQ({ rows }).q, "sub-1", VISIT)).resolves.toEqual({ role: null, live: false, copy: null });
    }
    // Only a true live column is live.
    await expect(readVisit(fakeQ({ rows: [{ role: "judge", live: "t" }] }).q, "sub-1", VISIT)).resolves.toEqual({
      role: "judge",
      live: false,
      copy: null,
    });
  });

  it("charges nothing for a bad visit id or amount, without a write", async () => {
    for (const [visitId, nanocents] of [
      ["not-a-visit", 1],
      [VISIT, -1],
      [VISIT, 1.5],
      [VISIT, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      const { q, calls } = fakeQ({ affected: 1 });
      await expect(chargeVisit(q, { visitId, sub: "sub-1", nanocents, limits: LIMITS, at: null })).resolves.toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("treats more than one charged row as unknown", async () => {
    await expect(
      chargeVisit(fakeQ({ affected: 2 }).q, { visitId: VISIT, sub: "sub-1", nanocents: 1, limits: LIMITS, at: null }),
    ).rejects.toMatchObject({ name: "DbError", category: "unknown" });
  });

  it("fails a settle the visit's row cannot take", async () => {
    for (const affected of [0, 2]) {
      await expect(
        settleVisit(fakeQ({ affected }).q, { visitId: VISIT, releaseNanocents: 1, spentNanocents: 1 }),
      ).rejects.toMatchObject({ name: "DbError", category: "unknown" });
    }
  });

  it("ends a turn gate for a bad visit id without a write", async () => {
    const { q, calls } = fakeQ({ affected: 1 });
    await expect(
      countVisitTurn(q, { visitId: "x", sub: "sub-1", turnsPerSession: 25, at: "2026-11-02T15:00:00.000Z" }),
    ).resolves.toBe("visit_ended");
    expect(calls).toEqual([]);
  });

  it("fails closed when a count is unreadable or the new row is not written", async () => {
    const unreadable = fakeQ({ rows: [] });
    await expect(
      startVisit(unreadable.q, { sub: "sub-1", ipHash: null, reuseId: null, limits: LIMITS, at: null }),
    ).rejects.toMatchObject({ name: "DbError" });

    const noRow = {
      query: async () => [{ used: 0, n: 0 }],
      execute: async () => 0,
    } as unknown as Queryable;
    await expect(startVisit(noRow, { sub: "sub-1", ipHash: null, reuseId: null, limits: LIMITS, at: null })).rejects.toMatchObject({
      name: "DbError",
    });

    const noLength = { query: async () => [{ used: 0, n: 0 }], execute: async () => 1 } as unknown as Queryable;
    await expect(
      startVisit(noLength, { sub: "sub-1", ipHash: null, reuseId: null, limits: { ...LIMITS, cookieHours: 0 }, at: null }),
    ).rejects.toMatchObject({ name: "DbError" });
  });
});

describe("atHome", () => {
  const HOME = "00000000-0000-4000-8000-0000000000a1";
  const COPY = "00000000-0000-4000-8000-0000000000c1";

  it("runs its work in the demo carrier, then sets the transaction back to the copy", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const q = {
      query: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        return [];
      },
    } as unknown as Queryable;
    const out = await atHome(q, HOME, COPY, async () => {
      seen.push({ sql: "work", params: [] });
      return 7;
    });
    expect(out).toBe(7);
    expect(seen).toEqual([
      { sql: "SELECT set_config('app.tenant_id', $1, true)", params: [HOME] },
      { sql: "work", params: [] },
      { sql: "SELECT set_config('app.tenant_id', $1, true)", params: [COPY] },
    ]);
  });

  it("refuses an id that is not a uuid, or a home that is the copy, before any SQL", async () => {
    for (const [home, copy] of [
      ["not-a-uuid", COPY],
      [HOME, "not-a-uuid"],
      [HOME, HOME],
    ]) {
      const { q, calls } = fakeQ();
      await expect(atHome(q, home, copy, async () => 1)).rejects.toMatchObject({ name: "DbError" });
      expect(calls).toEqual([]);
    }
  });
});
