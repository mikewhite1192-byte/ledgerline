import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import {
  CODE_ALPHABET,
  cookieValue,
  hashCode,
  mintCode,
  mintSession,
  normalizeCarrierNumber,
  normalizeCode,
  parseCookie,
  portalCookieOptions,
  sessionAlive,
  SIGN_IN_FAILURE_LIMIT,
  signIn,
} from "./session";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-27T15:00:00Z");

// A queryable that answers from a script and records every statement.
function fakeQ(answers: { accounts?: unknown[]; sessions?: unknown[]; updated?: number; alive?: unknown[] } = {}) {
  const calls: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM portal_accounts")) {
        return (answers.accounts ?? [{ carrier_number: "MC-123456", failed_sign_ins: 0, window_open: false }]) as T[];
      }
      if (sql.includes("session_expires_at >")) return (answers.alive ?? []) as T[];
      if (sql.includes("FROM portal_sessions")) return (answers.sessions ?? [{ id: SESSION_ID }]) as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE portal_accounts")) return 1;
      return sql.startsWith("UPDATE") ? (answers.updated ?? 1) : 1;
    },
  };
  return { q, calls };
}

describe("access codes", () => {
  it("draws eight characters from the 32-letter alphabet, one byte each", () => {
    const code = mintCode(() => new Uint8Array([0, 31, 32, 63, 255, 7, 8, 9]));
    expect(code).toBe(`${CODE_ALPHABET[0]}${CODE_ALPHABET[31]}${CODE_ALPHABET[0]}${CODE_ALPHABET[31]}${CODE_ALPHABET[31]}${CODE_ALPHABET[7]}${CODE_ALPHABET[8]}${CODE_ALPHABET[9]}`);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(() => mintCode(() => new Uint8Array(4))).toThrow();
  });

  it("normalizes what a person typed, and refuses what cannot be a code or carrier number", () => {
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeCode(" ABCD 2345 ")).toBe("ABCD2345");
    expect(normalizeCode("ABCD1345")).toBeNull();
    expect(normalizeCode("ABCD23456")).toBeNull();
    expect(normalizeCode(12345678)).toBeNull();
    expect(normalizeCarrierNumber(" mc-123456 ")).toBe("MC-123456");
    expect(normalizeCarrierNumber("MC-12345")).toBeNull();
    expect(normalizeCarrierNumber("MC-1234567")).toBeNull();
  });

  it("stores only the code's hash", async () => {
    const { q, calls } = fakeQ();
    const minted = await mintSession(q, { runId: null, createdBy: "sub-1", now: NOW }, () => new Uint8Array(8));
    expect(minted.code).toBe("22222222");
    expect(minted.expiresAt).toBe("2026-10-27T15:20:00.000Z");
    expect(calls[0].params).toContain(hashCode("22222222"));
    expect(calls[0].params).not.toContain("22222222");
  });
});

describe("signIn", () => {
  it("signs in once with this carrier's number and a live code", async () => {
    const { q, calls } = fakeQ();
    expect(await signIn(q, { carrierNumber: "mc-123456", code: "abcd2345", now: NOW })).toBe(SESSION_ID);
    const update = calls.find((c) => c.sql.startsWith("UPDATE"))!;
    expect(update.sql).toContain("signed_in_at IS NULL");
    expect(update.params).toEqual([SESSION_ID, NOW.toISOString(), "2026-10-27T16:00:00.000Z"]);
    // The account row is read locked, and a sign-in that worked counts nothing.
    expect(calls[0].sql).toContain("FOR UPDATE");
    expect(calls.some((c) => c.sql.startsWith("UPDATE portal_accounts"))).toBe(false);
  });

  it("refuses another carrier's number, compared whole, and counts the miss", async () => {
    const { q, calls } = fakeQ({ accounts: [{ carrier_number: "MC-1234567", failed_sign_ins: 0, window_open: false }] });
    expect(await signIn(q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBeNull();
    expect(calls.some((c) => c.sql.includes("FROM portal_sessions"))).toBe(false);
    const counted = calls.filter((c) => c.sql.startsWith("UPDATE portal_accounts"));
    expect(counted).toHaveLength(1);
    expect(counted[0].params).toEqual([NOW.toISOString()]);
  });

  it("refuses an unknown, used or expired code, and the loser of a race, counting each miss", async () => {
    for (const answers of [{ sessions: [] }, { updated: 0 }]) {
      const { q, calls } = fakeQ(answers);
      expect(await signIn(q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBeNull();
      expect(calls.filter((c) => c.sql.startsWith("UPDATE portal_accounts"))).toHaveLength(1);
    }
  });

  it("refuses even a right code at the limit inside the minute, without looking at codes", async () => {
    const locked = { carrier_number: "MC-123456", failed_sign_ins: SIGN_IN_FAILURE_LIMIT, window_open: true };
    const { q, calls } = fakeQ({ accounts: [locked] });
    expect(await signIn(q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBeNull();
    expect(calls).toHaveLength(1);
    // One short of the limit, or the same count once the minute is over, still signs in.
    const under = fakeQ({ accounts: [{ ...locked, failed_sign_ins: SIGN_IN_FAILURE_LIMIT - 1 }] });
    expect(await signIn(under.q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBe(SESSION_ID);
    const later = fakeQ({ accounts: [{ ...locked, window_open: false }] });
    expect(await signIn(later.q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBe(SESSION_ID);
  });

  it("fails closed when the count or the window does not read back as expected", async () => {
    for (const odd of [
      { carrier_number: "MC-123456", failed_sign_ins: "0", window_open: false },
      { carrier_number: "MC-123456", failed_sign_ins: 0, window_open: null },
      { carrier_number: "MC-123456" },
    ]) {
      const { q, calls } = fakeQ({ accounts: [odd] });
      expect(await signIn(q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBeNull();
      expect(calls).toHaveLength(1);
    }
    expect(await signIn(fakeQ({ accounts: [] }).q, { carrierNumber: "MC-123456", code: "ABCD2345", now: NOW })).toBeNull();
  });

  it("never queries for a malformed entry", async () => {
    const { q, calls } = fakeQ();
    expect(await signIn(q, { carrierNumber: "MC-123456", code: "' OR 1=1 --", now: NOW })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("checks a session is alive only for a uuid", async () => {
    const { q, calls } = fakeQ({ alive: [{ ok: 1 }] });
    expect(await sessionAlive(q, "nope", NOW)).toBe(false);
    expect(calls).toEqual([]);
    expect(await sessionAlive(q, SESSION_ID, NOW)).toBe(true);
  });
});

describe("the portal cookie", () => {
  it("carries the tenant and the session, and nothing else parses", () => {
    expect(parseCookie(cookieValue(TENANT, SESSION_ID))).toEqual({ tenantId: TENANT, sessionId: SESSION_ID });
    expect(parseCookie(`${TENANT}.${SESSION_ID}.x`)).toBeNull();
    expect(parseCookie(`${TENANT}.not-a-uuid`)).toBeNull();
    expect(parseCookie(undefined)).toBeNull();
  });

  it("is http-only, scoped to the portal, and secure in production", () => {
    expect(portalCookieOptions("production")).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/portal", maxAge: 3600 });
    expect(portalCookieOptions("development").secure).toBe(false);
  });
});
