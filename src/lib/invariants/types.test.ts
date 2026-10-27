import { describe, expect, it } from "vitest";
import { DbError, type Param, type Queryable } from "../db/types";
import {
  InvariantReadError,
  countOf,
  exitCodeOf,
  flag,
  formatLine,
  isReadSql,
  onlyRow,
  readFailureCategory,
  readOnly,
  readPaged,
  refuseUnread,
  resultOf,
  safeName,
  unreadable,
  verdictOf,
  whole,
  type InvariantId,
  type PageKey,
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

describe("aggregate counts", () => {
  it("takes whole counts of zero or more", () => {
    expect(countOf(0)).toBe(0);
    expect(countOf("42")).toBe(42);
    for (const bad of [-1, "-1", 1.5, null, "1.0", true]) expect(() => countOf(bad)).toThrow("not_whole");
  });

  it("takes exactly one aggregate row", () => {
    expect(onlyRow([{ n: 1 }], "x_unread")).toEqual({ n: 1 });
    expect(() => onlyRow([], "x_unread")).toThrow("x_unread");
    expect(() => onlyRow([{ n: 1 }, { n: 2 }], "x_unread")).toThrow("x_unread");
  });

  it("leaves the check unread when any record was refused", () => {
    expect(() => refuseUnread(0, "not_whole")).not.toThrow();
    expect(() => refuseUnread(1, "not_whole")).toThrow("not_whole");
    expect(() => refuseUnread("2", "not_boolean")).toThrow("not_boolean");
    expect(() => refuseUnread(null, "not_boolean")).toThrow("not_whole");
  });
});

describe("readPaged", () => {
  const SQL = { first: "SELECT first", after: "SELECT after" };
  const T = "00000000-0000-4000-8000-0000000000aa";
  type Row = PageKey & { n: number };
  const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const row = (n: number): Row => ({ page_tenant: T, page_id: key(n), n });

  // Answers each query with the next page given, recording what was asked.
  function pages(answers: Row[][]) {
    const calls: { sql: string; params?: Param[] }[] = [];
    const q = {
      query: async <R>(sql: string, params?: Param[]) => {
        calls.push({ sql, params });
        return (answers[calls.length - 1] ?? []) as R[];
      },
    };
    return { q, calls };
  }

  it("reads page after page, each after the last key, until a short page", async () => {
    const { q, calls } = pages([[row(1), row(2)], [row(3), row(4)], [row(5)]]);
    const rows = await readPaged<Row>(q, SQL, 2, 10);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toEqual([
      { sql: "SELECT first", params: [2] },
      { sql: "SELECT after", params: [T, key(2), 2] },
      { sql: "SELECT after", params: [T, key(4), 2] },
    ]);
  });

  it("stops at an empty page after a full one, and at a short first page", async () => {
    const full = pages([[row(1), row(2)], []]);
    expect((await readPaged<Row>(full.q, SQL, 2, 10)).map((r) => r.n)).toEqual([1, 2]);
    expect(full.calls).toHaveLength(2);
    const one = pages([[row(1)]]);
    expect((await readPaged<Row>(one.q, SQL, 2, 10)).map((r) => r.n)).toEqual([1]);
    expect(one.calls).toHaveLength(1);
  });

  it("fails closed at the page cap instead of returning part of the rows", async () => {
    const { q, calls } = pages([[row(1), row(2)], [row(3), row(4)], [row(5), row(6)], [row(7)]]);
    await expect(readPaged(q, SQL, 2, 3)).rejects.toMatchObject({ category: "page_cap" });
    expect(calls).toHaveLength(3);
  });

  it("fails closed on a key it cannot read, never guessing the next page", async () => {
    for (const bad of [{ page_tenant: T, page_id: 42 }, { page_tenant: null, page_id: key(2) }, { page_tenant: T, page_id: "2" }]) {
      const { q, calls } = pages([[row(1), { ...row(2), ...bad }], [row(3)]]);
      await expect(readPaged(q, SQL, 2, 10)).rejects.toMatchObject({ category: "page_key_unread" });
      expect(calls).toHaveLength(1);
    }
  });

  it("passes a read failure through as it came", async () => {
    const q = {
      query: async () => {
        throw new DbError("timeout", "57014");
      },
    };
    await expect(readPaged(q, SQL, 2, 10)).rejects.toMatchObject({ name: "DbError", category: "timeout" });
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
