import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { DbError, type Queryable } from "@/lib/db";
import { readDeskFacts, readDigestLine, readTourFacts } from "./facts";

// The walkthrough's reads on a fake connection: the digest's newest line within three days, the
// desk's check-in and today's finished count from the carrier's midnight, and one failed read that
// leaves the others standing. Every date and instant is fixed; nothing reads the wall clock.

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn() }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

type Read = { sql: string; params: unknown[] };

function fake(answer: (sql: string, params: unknown[]) => unknown[]): { q: Queryable; reads: Read[] } {
  const reads: Read[] = [];
  return {
    reads,
    q: {
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        reads.push({ sql, params });
        return answer(sql, params) as T[];
      },
      async execute() {
        throw new Error("the walkthrough writes nothing");
      },
    },
  };
}

// 10:00 AM on Nov 10 in Chicago.
const NOW = new Date("2026-11-10T16:00:00.000Z");

describe("readDigestLine", () => {
  it("asks for the newest digest from two days back and returns its words", async () => {
    const { q, reads } = fake(() => [{ text: "Good morning." }]);
    expect(await readDigestLine(q, "2026-11-10")).toBe("Good morning.");
    expect(reads[0].sql).toContain("kind = 'digest'");
    expect(reads[0].sql).toContain("ORDER BY period_date DESC LIMIT 1");
    expect(reads[0].params).toEqual(["2026-11-08"]);
  });

  it("is null with no line, and a read that cannot be trusted fails", async () => {
    expect(await readDigestLine(fake(() => []).q, "2026-11-10")).toBeNull();
    expect(await readDigestLine(fake(() => [{ text: "  " }]).q, "2026-11-10")).toBeNull();
    await expect(readDigestLine(fake(() => [{ text: 7 }]).q, "2026-11-10")).rejects.toBeInstanceOf(DbError);
  });
});

describe("readDeskFacts", () => {
  it("reads the desk's last check-in and what it finished since the carrier's midnight", async () => {
    const { q, reads } = fake((sql) => {
      if (sql.includes("kind = 'sleep'")) return [{ at: "2026-11-10T15:30:00.000000Z" }];
      if (sql.includes("kind = 'done'")) return [{ n: 3 }];
      return [];
    });
    expect(await readDeskFacts(q, NOW, "America/Chicago")).toEqual({ checkedAt: "2026-11-10T15:30:00.000000Z", doneToday: 3 });
    const done = reads.find((r) => r.sql.includes("kind = 'done'"));
    // Midnight on Nov 10 in Chicago (CST, six hours behind).
    expect(done?.params).toEqual(["2026-11-10T06:00:00.000Z"]);
  });

  it("fails on a count that is not a whole number, never reading it as 0", async () => {
    const { q } = fake((sql) => (sql.includes("kind = 'sleep'") ? [{ at: null }] : sql.includes("kind = 'done'") ? [{ n: null }] : []));
    await expect(readDeskFacts(q, NOW, "America/Chicago")).rejects.toBeInstanceOf(DbError);
  });
});

describe("readTourFacts", () => {
  const saved = { mockTms: flags.mockTms.enabled, rules: flags.autopilotRules.enabled, digest: flags.morningDigest.enabled };
  beforeEach(() => {
    flags.mockTms.enabled = false;
    flags.autopilotRules.enabled = false;
    flags.morningDigest.enabled = true;
  });
  afterEach(() => {
    flags.mockTms.enabled = saved.mockTms;
    flags.autopilotRules.enabled = saved.rules;
    flags.morningDigest.enabled = saved.digest;
    vi.clearAllMocks();
  });

  it("keeps the other reads when one fails, and leaves out the steps whose switches are off", async () => {
    const { q } = fake((sql) => {
      if (sql.includes("agent_asks")) throw new DbError("timeout");
      if (sql.includes("kind = 'sleep'")) return [{ at: null }];
      if (sql.includes("kind = 'done'")) return [{ n: 0 }];
      return [];
    });
    mocks.withRequestTenant.mockImplementation((fn: (q: Queryable) => unknown) => fn(q));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const facts = await readTourFacts({ now: NOW, today: "2026-11-10", timezone: "America/Chicago" });
      expect(facts).toEqual({
        digest: { ok: false },
        desk: { ok: true, value: { checkedAt: null, doneToday: 0 } },
        autopilot: null,
        board: null,
      });
      // Only the error's name reaches the log.
      expect(log.mock.calls).toEqual([["home card read failed:", "tour digest", "DbError"]]);
    } finally {
      log.mockRestore();
    }
  });

  it("reads no digest line while the digest is off", async () => {
    flags.morningDigest.enabled = false;
    const { q, reads } = fake((sql) =>
      sql.includes("kind = 'sleep'") ? [{ at: null }] : sql.includes("kind = 'done'") ? [{ n: 0 }] : [],
    );
    mocks.withRequestTenant.mockImplementation((fn: (q: Queryable) => unknown) => fn(q));
    const facts = await readTourFacts({ now: NOW, today: "2026-11-10", timezone: "America/Chicago" });
    expect(facts.digest).toEqual({ ok: true, value: null });
    expect(reads.some((r) => r.sql.includes("agent_asks"))).toBe(false);
  });
});
