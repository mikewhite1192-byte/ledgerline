import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import type { Session } from "./claims";

// getSession() and requireSession() with and without a demo visit cookie. The cookie jar, the
// token check and the database are fakes; readVisit (src/lib/auth/demo-visit.ts) is the real one,
// reading the scripted rows.

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const VISIT = "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c1a90";
const TOKEN_SESSION: Session = { sub: "sub-judge", email: "judge@blueridge.example", tenantId: TENANT };

const state = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  session: null as Session | null,
  rows: [] as unknown[],
  fail: null as Error | null,
  calls: [] as { tenant: string; sql: string; params: unknown[] }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
}));
vi.mock("./verify", () => ({ verifyIdToken: async (token: string) => (token === "good-token" ? state.session : null) }));
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: () => ({
    withTenant: async <T,>(tenant: string, fn: (q: Queryable) => Promise<T>) => {
      const q = {
        query: async (sql: string, params: unknown[] = []) => {
          state.calls.push({ tenant, sql, params });
          if (state.fail) throw state.fail;
          return state.rows;
        },
        execute: async () => {
          throw new Error("getSession never writes");
        },
      } as unknown as Queryable;
      return fn(q);
    },
  }),
}));

const { getSession, requireSession } = await import("./session");

const saved = flags.judgeAccess.enabled;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.cookies = { pc_session: "good-token", pc_demo: VISIT };
  state.session = { ...TOKEN_SESSION };
  state.rows = [];
  state.fail = null;
  state.calls = [];
  flags.judgeAccess.enabled = true;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.judgeAccess.enabled = saved;
  errors.mockRestore();
});

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  return (err as { to?: string } | null)?.to ?? "no redirect";
}

describe("getSession", () => {
  it("has no session without a cookie or with a token that does not verify, and reads nothing", async () => {
    state.cookies = {};
    await expect(getSession()).resolves.toBeNull();
    state.cookies = { pc_session: "bad-token", pc_demo: VISIT };
    await expect(getSession()).resolves.toBeNull();
    expect(state.calls).toHaveLength(0);
  });

  it("is the token's session, unread, with no visit cookie or with the switch off", async () => {
    state.cookies = { pc_session: "good-token" };
    await expect(getSession()).resolves.toEqual(TOKEN_SESSION);
    state.cookies = { pc_session: "good-token", pc_demo: VISIT };
    flags.judgeAccess.enabled = false;
    await expect(getSession()).resolves.toEqual(TOKEN_SESSION);
    expect(state.calls).toHaveLength(0);
  });

  it("gives a judge with a live visit the visit, read in the token's tenant", async () => {
    state.rows = [{ role: "judge", live: true }];
    await expect(getSession()).resolves.toEqual({ ...TOKEN_SESSION, demoSessionId: VISIT });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].tenant).toBe(TENANT);
    expect(state.calls[0].params).toEqual(["sub-judge", VISIT]);
    expect(state.calls[0].sql).toContain("current_tenant_id()");
  });

  it("has no session for a judge whose visit ended, and requireSession says so", async () => {
    state.rows = [{ role: "judge", live: false }];
    await expect(getSession()).resolves.toBeNull();
    expect(await redirectOf(requireSession())).toBe("/sign-in?demo=expired");
  });

  it("ignores the cookie for admin and staff, ended or not", async () => {
    for (const role of ["admin", "staff"]) {
      for (const live of [true, false]) {
        state.rows = [{ role, live }];
        await expect(getSession()).resolves.toEqual(TOKEN_SESSION);
      }
    }
  });

  it("gives no visit when the role is missing, doubled or unknown (fail closed)", async () => {
    for (const rows of [[], [{ role: "judge", live: true }, { role: "judge", live: true }], [{ role: "owner", live: true }]]) {
      state.rows = rows;
      const session = await getSession();
      expect(session).toEqual(TOKEN_SESSION);
      expect(session?.demoSessionId).toBeUndefined();
    }
  });

  it("gives no visit for a cookie that is not a visit id, without a read", async () => {
    state.cookies = { pc_session: "good-token", pc_demo: "not-a-uuid" };
    state.rows = [{ role: "judge", live: true }];
    const session = await getSession();
    expect(session?.demoSessionId).toBeUndefined();
    expect(state.calls).toHaveLength(0);
  });

  it("keeps the session without the visit when the read fails, logging the error's name only", async () => {
    state.fail = Object.assign(new Error("connection text"), { name: "DbError" });
    const session = await getSession();
    expect(session).toEqual(TOKEN_SESSION);
    expect(session?.demoSessionId).toBeUndefined();
    expect(errors).toHaveBeenCalledWith("session: the demo visit could not be read (DbError)");
  });
});

describe("requireSession", () => {
  it("sends a signed-out request to the plain sign-in page", async () => {
    state.cookies = {};
    expect(await redirectOf(requireSession())).toBe("/sign-in");
  });

  it("returns the visit's session for a live judge", async () => {
    state.rows = [{ role: "judge", live: true }];
    await expect(requireSession()).resolves.toEqual({ ...TOKEN_SESSION, demoSessionId: VISIT });
  });
});
