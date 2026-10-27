import { describe, expect, it } from "vitest";
import { DbError, type Queryable } from "../db/types";
import {
  InvariantReadError,
  exitCodeOf,
  flag,
  formatLine,
  isReadSql,
  readFailureCategory,
  readOnly,
  resultOf,
  safeName,
  unreadable,
  verdictOf,
  whole,
  type InvariantId,
} from "./types";

const pass = (id: InvariantId) => resultOf(id, { rows: 1 }, {});

describe("whole", () => {
  it("takes safe integers and digit strings", () => {
    expect(whole(0)).toBe(0);
    expect(whole(-12)).toBe(-12);
    expect(whole("150")).toBe(150);
    expect(whole("-7")).toBe(-7);
  });

  it("treats anything else as unknown, never zero", () => {
    for (const bad of [null, undefined, 1.5, Number.NaN, 2 ** 53, "", "1.0", "12a", " 1", "99999999999999999", true, {}]) {
      expect(() => whole(bad)).toThrow(InvariantReadError);
    }
  });
});

describe("flag", () => {
  it("takes booleans only", () => {
    expect(flag(true)).toBe(true);
    expect(flag(false)).toBe(false);
    for (const bad of [null, 0, 1, "true", "t", undefined]) expect(() => flag(bad)).toThrow(InvariantReadError);
  });
});

describe("verdictOf and resultOf", () => {
  it("is FAIL on any violation, even with something unread", () => {
    expect(verdictOf({ a: 1 }, ["x"])).toBe("FAIL");
  });

  it("is UNKNOWN when something is unread and nothing failed", () => {
    expect(verdictOf({ a: 0 }, ["x"])).toBe("UNKNOWN");
  });

  it("is PASS only on a full, clean read", () => {
    expect(verdictOf({ a: 0 }, [])).toBe("PASS");
  });

  it("drops zero counts and dedupes and sorts the unread", () => {
    const r = resultOf("I3", { advances: 2 }, { a: 0, b: 2 }, ["z", "a", "z"]);
    expect(r).toEqual({
      id: "I3",
      name: "approvals",
      verdict: "FAIL",
      counts: { advances: 2 },
      violations: { b: 2 },
      unknown: ["a", "z"],
    });
  });
});

describe("readFailureCategory", () => {
  it("names a database error by category and SQLSTATE only", () => {
    expect(readFailureCategory(new DbError("rls_denied", "42501"))).toBe("read_failed_rls_denied_42501");
    expect(readFailureCategory(new DbError("unknown"))).toBe("read_failed_unknown");
  });

  it("keeps an invariant's own category", () => {
    expect(readFailureCategory(new InvariantReadError("not_whole"))).toBe("not_whole");
  });

  it("never carries an error's message", () => {
    const err = new Error("password authentication failed for user secret-user");
    expect(readFailureCategory(err)).toBe("read_failed");
    expect(unreadable("I1", err)).toEqual({
      id: "I1",
      name: "ledger",
      verdict: "UNKNOWN",
      counts: {},
      violations: {},
      unknown: ["read_failed"],
    });
  });
});

describe("safeName", () => {
  it("passes plain identifiers and hides anything else", () => {
    expect(safeName("money_actions")).toBe("money_actions");
    expect(safeName("ops.ai_spend")).toBe("ops.ai_spend");
    expect(safeName("Robert'); DROP")).toBe("unnamed");
    expect(safeName(42)).toBe("unnamed");
  });
});

describe("read-only access", () => {
  it("accepts one SELECT only", () => {
    expect(isReadSql("SELECT 1")).toBe(true);
    expect(isReadSql("  select\n count(*) FROM x")).toBe(true);
    expect(isReadSql("SELECT 1; DELETE FROM x")).toBe(false);
    expect(isReadSql("UPDATE x SET a = 1")).toBe(false);
    expect(isReadSql("WITH d AS (DELETE FROM x RETURNING 1) SELECT * FROM d")).toBe(false);
    expect(isReadSql("SELECTED")).toBe(false);
  });

  it("refuses anything else before it reaches the database", async () => {
    const calls: string[] = [];
    const q: Queryable = {
      query: async <T>(sql: string) => {
        calls.push(sql);
        return [] as T[];
      },
      execute: async () => 0,
    };
    const ro = readOnly(q);
    await expect(ro.query("DELETE FROM money_actions")).rejects.toMatchObject({ category: "refused_not_select" });
    await expect(ro.query("SELECT 1")).resolves.toEqual([]);
    expect(calls).toEqual(["SELECT 1"]);
  });
});

describe("formatLine", () => {
  it("prints the verdict and counts on a pass", () => {
    expect(formatLine(resultOf("I1", { settlements: 150, payouts: 0 }, {}))).toBe(
      "I1 ledger: PASS (settlements 150, payouts 0)",
    );
  });

  it("prints violations and unread categories before the counts", () => {
    const r = resultOf("I5", { tables: 32 }, { "rls_off:drivers": 1 }, ["insert_probe_unclear"]);
    expect(formatLine(r)).toBe("I5 row security: FAIL (rls_off:drivers 1, insert_probe_unclear; tables 32)");
  });

  it("prints a bare unread category", () => {
    expect(formatLine(resultOf("I4", {}, {}, ["read_failed_unavailable"]))).toBe(
      "I4 model calls: UNKNOWN (read_failed_unavailable)",
    );
  });
});

describe("exitCodeOf", () => {
  const all = (["I1", "I2", "I3", "I4", "I5"] as const).map(pass);

  it("is zero only when all five ran and passed", () => {
    expect(exitCodeOf(all)).toBe(0);
  });

  it("is one on a FAIL or an UNKNOWN", () => {
    expect(exitCodeOf([...all.slice(0, 4), resultOf("I5", {}, { x: 1 })])).toBe(1);
    expect(exitCodeOf([...all.slice(0, 4), resultOf("I5", {}, {}, ["x"])])).toBe(1);
  });

  it("is one when a check is missing or repeated", () => {
    expect(exitCodeOf(all.slice(0, 4))).toBe(1);
    expect(exitCodeOf([...all.slice(0, 4), pass("I4")])).toBe(1);
    expect(exitCodeOf([...all, pass("I1")])).toBe(1);
    expect(exitCodeOf([])).toBe(1);
  });
});
