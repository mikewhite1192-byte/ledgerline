import { describe, expect, it } from "vitest";
import type { Session } from "../auth/claims";
import { DbError, type Param, type Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { NANOCENTS_PER_CENT } from "./prices";
import { QUIET_JOB } from "./test-fixtures";
import {
  checkJob,
  clearSpendAlert,
  jobCapNanocents,
  readDaySpend,
  readSpendAlerts,
  withinAllowance,
  type JobCheck,
} from "./watch";

// The spend watch on fake rows: the allowance math, what checkJob reads and writes, and the
// admin-only clear. The database's own window math is in spend.db.test.ts.

const CAP = 1_000 * NANOCENTS_PER_CENT;
const TRACE = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-27T06:00:00.000Z";
const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

type Seen = { sql: string; params: Param[] };

function fakeQ(answer: (sql: string, params: Param[]) => unknown[], affected: (sql: string) => number = () => 1) {
  const queries: Seen[] = [];
  const writes: Seen[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      queries.push({ sql, params });
      return answer(sql, params) as T[];
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      writes.push({ sql, params });
      return affected(sql);
    },
  };
  return { q, queries, writes };
}

const check = (over: Partial<JobCheck> = {}): JobCheck => ({
  traceId: TRACE,
  purpose: "agent_operator_turn",
  at: AT,
  jobCapNanocents: CAP,
  reserveNanocents: 900_000_000,
  ...over,
});

describe("the allowance", () => {
  it("allows a call that reaches the allowance exactly, and refuses one past it", () => {
    expect(withinAllowance(CAP - 5, 5, CAP)).toBe(true);
    expect(withinAllowance(CAP - 5, 6, CAP)).toBe(false);
    expect(withinAllowance(0, CAP + 1, CAP)).toBe(false);
  });

  it("turns the flag into nanocents, and refuses anything but a positive whole number of cents", () => {
    expect(jobCapNanocents(1000)).toBe(1_000_000_000_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(jobCapNanocents(bad), String(bad)).toBeNull();
    }
  });
});

describe("checkJob", () => {
  it("lets a call through when the job has room, writing nothing", async () => {
    const f = fakeQ(() => [{ ...QUIET_JOB, spent_nanocents: CAP - 900_000_000 }]);
    expect(await checkJob(f.q, check())).toBe("ok");
    expect(f.writes).toEqual([]);
    // A traced job is read by its trace; the window ends at the given instant.
    expect(f.queries[0].params).toEqual([TRACE, AT]);
    expect(f.queries[0].sql).toContain("m.trace_id = CAST($1 AS uuid)");
    expect(f.queries[0].sql).not.toContain("m.purpose = $1");
  });

  it("reads a job with no trace by its purpose, among calls with no trace", async () => {
    const f = fakeQ(() => [QUIET_JOB]);
    expect(await checkJob(f.q, check({ traceId: null, at: null }))).toBe("ok");
    expect(f.queries[0].params).toEqual(["agent_operator_turn", null]);
    expect(f.queries[0].sql).toContain("m.trace_id IS NULL AND m.purpose = $1");
  });

  it("stops a call that would go past the allowance and writes one alert with the window it used", async () => {
    const f = fakeQ(() => [{ ...QUIET_JOB, spent_nanocents: CAP - 899_999_999 }]);
    expect(await checkJob(f.q, check())).toBe("job_cap");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].sql).toContain("INSERT INTO spend_alerts");
    expect(f.writes[0].sql).toContain("ON CONFLICT DO NOTHING");
    expect(f.writes[0].params).toEqual([
      TRACE,
      "agent_operator_turn",
      QUIET_JOB.window_start,
      QUIET_JOB.window_end,
      CAP + 1,
      CAP,
      AT,
    ]);
  });

  it("refuses every call of a job with an open alert, without a second alert", async () => {
    const f = fakeQ(() => [{ ...QUIET_JOB, open_alerts: 1 }]);
    expect(await checkJob(f.q, check({ reserveNanocents: 1 }))).toBe("job_cap");
    expect(f.writes).toEqual([]);
  });

  it("is still a stop when the alert insert finds one already open", async () => {
    const f = fakeQ(() => [{ ...QUIET_JOB, spent_nanocents: CAP }], () => 0);
    expect(await checkJob(f.q, check())).toBe("job_cap");
  });

  it("fails closed on a read it cannot trust: missing, negative, not whole, or a bad instant", async () => {
    for (const row of [
      undefined,
      { ...QUIET_JOB, spent_nanocents: -1 },
      { ...QUIET_JOB, spent_nanocents: 1.5 },
      { ...QUIET_JOB, spent_nanocents: "12" },
      { ...QUIET_JOB, open_alerts: null },
      { ...QUIET_JOB, window_start: "2026-10-27 05:00:00" },
      { ...QUIET_JOB, window_end: null },
    ]) {
      const f = fakeQ(() => (row === undefined ? [] : [row]));
      await expect(checkJob(f.q, check()), JSON.stringify(row)).rejects.toBeInstanceOf(DbError);
      expect(f.writes).toEqual([]);
    }
  });

  it("lets a read error through, so the reservation fails closed", async () => {
    const q: Queryable = {
      query: async () => {
        throw new DbError("unavailable");
      },
      execute: async () => 1,
    };
    await expect(checkJob(q, check())).rejects.toBeInstanceOf(DbError);
  });

  it("refuses an allowance that is not a positive whole number before reading anything", async () => {
    const f = fakeQ(() => [QUIET_JOB]);
    await expect(checkJob(f.q, check({ jobCapNanocents: 0 }))).rejects.toBeInstanceOf(DbError);
    expect(f.queries).toEqual([]);
  });

  it("fails closed on an insert that reports more than one row", async () => {
    const f = fakeQ(() => [{ ...QUIET_JOB, spent_nanocents: CAP }], () => 2);
    await expect(checkJob(f.q, check())).rejects.toBeInstanceOf(DbError);
  });
});

describe("clearSpendAlert", () => {
  const ALERT = "33333333-3333-4333-8333-333333333333";
  const MEMBER = "44444444-4444-4444-8444-444444444444";

  function member(role: "admin" | "staff" | null, updated = 1, exists = true) {
    return fakeQ(
      (sql) => {
        if (sql.includes("FROM memberships")) return role === null ? [] : [{ id: MEMBER, role }];
        if (sql.includes("FROM spend_alerts")) return exists ? [{ id: ALERT }] : [];
        throw new Error("unexpected query");
      },
      () => updated,
    );
  }

  it("clears an open alert for an admin and records who and when", async () => {
    const f = member("admin");
    expect(await clearSpendAlert(f.q, SESSION, ALERT, AT)).toBe("cleared");
    expect(f.queries[0].params).toEqual([SESSION.sub]);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].sql).toContain("cleared_at IS NULL");
    expect(f.writes[0].sql).toContain("tenant_id = current_tenant_id()");
    expect(f.writes[0].params).toEqual([ALERT, AT, MEMBER]);
  });

  it("refuses staff and a login with no membership, writing nothing", async () => {
    for (const role of ["staff", null] as const) {
      const f = member(role);
      await expect(clearSpendAlert(f.q, SESSION, ALERT, AT)).rejects.toBeInstanceOf(ForbiddenError);
      expect(f.writes).toEqual([]);
    }
  });

  it("tells an alert already cleared from one that is not this carrier's", async () => {
    expect(await clearSpendAlert(member("admin", 0, true).q, SESSION, ALERT, AT)).toBe("already_cleared");
    expect(await clearSpendAlert(member("admin", 0, false).q, SESSION, ALERT, AT)).toBe("not_found");
  });
});

describe("the page reads", () => {
  it("maps alerts, and fails closed on an amount that is not a safe whole number", async () => {
    const row = {
      id: "a1",
      trace_id: null,
      purpose: "proof",
      spent_nanocents: CAP + 1,
      limit_nanocents: CAP,
      created_iso: "2026-10-27T06:00:00.000Z",
      cleared_iso: null,
      cleared_by_email: null,
    };
    const ok = fakeQ(() => [row]);
    expect(await readSpendAlerts(ok.q, 20)).toEqual([
      {
        id: "a1",
        traceId: null,
        purpose: "proof",
        spentNanocents: CAP + 1,
        limitNanocents: CAP,
        createdAt: "2026-10-27T06:00:00.000Z",
        clearedAt: null,
        clearedByEmail: null,
      },
    ]);
    expect(ok.queries[0].params).toEqual([20]);
    await expect(readSpendAlerts(fakeQ(() => [{ ...row, spent_nanocents: "1" }]).q, 20)).rejects.toBeInstanceOf(DbError);
  });

  it("reads the last day's spend, and never turns an unreadable sum into zero", async () => {
    const ok = fakeQ(() => [{ spent_nanocents: 5, calls: 2 }]);
    expect(await readDaySpend(ok.q, AT)).toEqual({ spentNanocents: 5, calls: 2 });
    expect(ok.queries[0].params).toEqual([AT]);
    for (const bad of [[], [{ spent_nanocents: null, calls: 0 }], [{ spent_nanocents: 0, calls: -1 }]]) {
      await expect(readDaySpend(fakeQ(() => bad).q, null)).rejects.toBeInstanceOf(DbError);
    }
  });
});
