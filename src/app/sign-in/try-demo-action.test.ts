import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Queryable } from "@/lib/db";
import type { Session } from "@/lib/auth/claims";
import { JUDGE_SIGN_INS_PER_MINUTE, resetJudgeSignIns } from "@/lib/auth/judge-throttle";

// Every branch of "Try the demo carrier": the switch, the process's brake on sign-ins, the stored
// login, the password sign-in, the token, the role (only a judge gets in; a missing or unknown role
// fails closed) and the visit's limits. The login, Cognito, the token check, the cookie jar and the database are fakes; the role
// read (src/lib/auth/role.ts) and the visit (src/lib/auth/demo-visit.ts) are the real ones, reading
// the scripted rows. A refusal never sets a cookie and never writes.

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const KEPT = "6f1c2a8e-4b7d-4c1e-9a3f-2d5e8b7c1a90";
// Made-up values that stand in for the stored login and the token.
const LOGIN = { email: "judge@blueridge.example", password: ["not", "a", "real", "password", "T7"].join("-") };
const TOKEN = "made-up-id-token";
const SESSION: Session = { sub: "sub-judge", email: LOGIN.email, tenantId: TENANT };

type SignIn = { ok: true; idToken: string } | { ok: false; reason: "invalid_credentials" | "unavailable" };

const state = vi.hoisted(() => ({
  login: null as { email: string; password: string } | null,
  signIn: null as unknown,
  session: null as unknown,
  role: [] as unknown[],
  used: 0,
  live: [] as unknown[],
  perAddress: 0,
  perHour: 0,
  perDay: 0,
  dbFail: null as Error | null,
  cookies: {} as Record<string, string>,
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
  forwardedFor: null as string | null,
  queries: [] as { tenant: string; sql: string; params: unknown[] }[],
  writes: [] as { sql: string; params: unknown[] }[],
  signInCalls: [] as string[][],
  loginReads: 0,
  forgot: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in state.cookies ? { name, value: state.cookies[name] } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => state.set.push({ name, value, options }),
  }),
  headers: async () => ({ get: (name: string) => (name === "x-forwarded-for" ? state.forwardedFor : null) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
}));
vi.mock("@/lib/auth/judge-login", () => ({
  judgeLogin: async () => {
    state.loginReads += 1;
    return state.login;
  },
  forgetJudgeLogin: () => {
    state.forgot += 1;
  },
}));
vi.mock("@/lib/auth/cognito", () => ({
  signIn: async (email: string, password: string) => {
    state.signInCalls.push([email, password]);
    return state.signIn;
  },
}));
vi.mock("@/lib/auth/verify", () => ({
  verifyIdToken: async (token: string) => (token === TOKEN ? state.session : null),
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({
    withTenant: async <T,>(tenant: string, fn: (q: Queryable) => Promise<T>) => {
      const q = {
        query: async (sql: string, params: unknown[] = []) => {
          state.queries.push({ tenant, sql, params });
          if (state.dbFail) throw state.dbFail;
          if (sql.includes("FROM memberships")) return state.role;
          if (sql.includes("SUM(spent_nanocents")) return [{ used: state.used }];
          if (sql.startsWith("SELECT id FROM demo_sessions")) return state.live;
          if (sql.includes("ip_hash IS NOT DISTINCT FROM")) return [{ n: state.perAddress }];
          if (sql.includes("interval '1 hour'")) return [{ n: state.perHour }];
          if (sql.includes("COUNT(*)")) return [{ n: state.perDay }];
          throw new Error(`unexpected read: ${sql}`);
        },
        execute: async (sql: string, params: unknown[] = []) => {
          state.writes.push({ sql, params });
          return 1;
        },
      } as unknown as Queryable;
      return fn(q);
    },
  }),
}));

const { tryDemoAction } = await import("./try-demo-action");

const saved = { ...flags.judgeAccess };
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(state, {
    login: { ...LOGIN },
    signIn: { ok: true, idToken: TOKEN } satisfies SignIn,
    session: { ...SESSION },
    role: [{ role: "judge" }],
    used: 0,
    live: [],
    perAddress: 0,
    perHour: 0,
    perDay: 0,
    dbFail: null,
    cookies: {},
    set: [],
    forwardedFor: "203.0.113.7, 10.0.0.1",
    queries: [],
    writes: [],
    signInCalls: [],
    loginReads: 0,
    forgot: 0,
  });
  resetJudgeSignIns();
  flags.judgeAccess.enabled = true;
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(flags.judgeAccess, saved);
  info.mockRestore();
  error.mockRestore();
});

async function run(): Promise<string> {
  const err = await tryDemoAction().then(
    () => null,
    (e: unknown) => e,
  );
  const to = (err as { to?: string } | null)?.to;
  if (!to) throw new Error("the action did not redirect");
  return to;
}

function logs(): string {
  return [...info.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join("\n");
}

// A refusal: back to the sign-in page with its one line, no cookie, no write, the category logged.
async function expectRefused(category: string) {
  expect(await run()).toBe("/sign-in?demo=unavailable");
  expect(state.set).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(info).toHaveBeenCalledWith(`demo sign-in: refused (${category})`);
  expect(logs()).not.toContain(LOGIN.password);
  expect(logs()).not.toContain(LOGIN.email);
  expect(logs()).not.toContain(TOKEN);
}

describe("tryDemoAction refusals", () => {
  it("is off while flags.judgeAccess is off: no login read, no sign-in", async () => {
    flags.judgeAccess.enabled = false;
    await expectRefused("disabled");
    expect(state.signInCalls).toEqual([]);
    expect(state.queries).toEqual([]);
  });

  it("is off when the visit length is not a positive number of hours", async () => {
    for (const hours of [0, -1, Number.NaN]) {
      flags.judgeAccess.cookieHours = hours;
      await expectRefused("disabled");
    }
    expect(state.signInCalls).toEqual([]);
  });

  it("is refused past the process's sign-ins for the minute, with no secret read and no Cognito call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 2, 15, 0, 0));
    try {
      for (let i = 0; i < JUDGE_SIGN_INS_PER_MINUTE; i++) expect(await run()).toBe("/");
      Object.assign(state, { set: [], writes: [], signInCalls: [], loginReads: 0 });
      await expectRefused("pace");
      expect(state.loginReads).toBe(0);
      expect(state.signInCalls).toEqual([]);
      // A minute on, the next click signs in again.
      vi.setSystemTime(Date.UTC(2026, 10, 2, 15, 1, 0));
      expect(await run()).toBe("/");
      expect(state.signInCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused when the stored login is missing or unreadable", async () => {
    state.login = null;
    await expectRefused("secret");
    expect(state.signInCalls).toEqual([]);
  });

  it("forgets the kept login when Cognito says it is wrong, so a reset is read on the next click", async () => {
    state.signIn = { ok: false, reason: "invalid_credentials" } satisfies SignIn;
    await expectRefused("credentials");
    expect(state.forgot).toBe(1);
    expect(state.signInCalls).toEqual([[LOGIN.email, LOGIN.password]]);
  });

  it("is refused when Cognito is unavailable, keeping the login", async () => {
    state.signIn = { ok: false, reason: "unavailable" } satisfies SignIn;
    await expectRefused("cognito");
    expect(state.forgot).toBe(0);
  });

  it("is refused when the token does not verify", async () => {
    state.session = null;
    await expectRefused("token");
    expect(state.queries).toEqual([]);
  });

  it("lets only a judge in: admin and staff are refused before any visit is read", async () => {
    for (const role of ["admin", "staff"]) {
      state.role = [{ role }];
      state.queries = [];
      info.mockClear();
      await expectRefused("role");
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0].sql).toContain("FROM memberships");
      expect(state.queries[0].tenant).toBe(TENANT);
    }
  });

  it("fails closed on a missing, doubled or unknown role", async () => {
    for (const rows of [[], [{ role: "judge" }, { role: "judge" }], [{ role: "owner" }], [{ role: null }]]) {
      state.role = rows;
      info.mockClear();
      await expectRefused("role");
    }
  });

  it("is refused when the token has no subject", async () => {
    state.session = { ...SESSION, sub: "" };
    await expectRefused("role");
    expect(state.queries).toEqual([]);
  });

  it("is refused when the day's spend has reached the day cap, even with a live visit", async () => {
    state.used = flags.judgeAccess.dayCapCents * 1_000_000_000;
    state.cookies = { pc_demo: KEPT };
    state.live = [{ id: KEPT }];
    await expectRefused("day_cap");
  });

  it("is refused at the per-address limit for the hour", async () => {
    state.perAddress = flags.judgeAccess.sessionsPerIpPerHour;
    await expectRefused("ip_limit");
  });

  it("is refused at the limit of new visits for the day", async () => {
    state.perDay = flags.judgeAccess.sessionsPerDay;
    await expectRefused("day_limit");
  });

  it("is refused at the limit of new visits for the hour across every address", async () => {
    state.perHour = flags.judgeAccess.sessionsPerHour;
    await expectRefused("hour_limit");
  });

  it("is unavailable when the database fails, logging the error's name only", async () => {
    state.dbFail = Object.assign(new Error(`text with ${LOGIN.email}`), { name: "DbError" });
    await expectRefused("unavailable");
    expect(error).toHaveBeenCalledWith("demo sign-in: the visit could not start (DbError)");
  });
});

describe("tryDemoAction sign-in", () => {
  it("starts a visit and sets both cookies for the visit's hours", async () => {
    flags.judgeAccess.cookieHours = 2;
    expect(await run()).toBe("/");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].sql).toContain("INSERT INTO demo_sessions");
    const id = state.writes[0].params[0] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // The address is stored hashed, never as written.
    const ipHash = state.writes[0].params[4] as string;
    expect(ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(state.writes)).not.toContain("203.0.113.7");
    expect(state.set.map((c) => [c.name, c.value])).toEqual([
      ["pc_session", TOKEN],
      ["pc_demo", id],
    ]);
    for (const c of state.set) {
      expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 7200 });
    }
    expect(info).toHaveBeenCalledWith("demo sign-in: visit started");
  });

  it("keeps a live visit the browser already holds, with no new row", async () => {
    state.cookies = { pc_demo: KEPT };
    state.live = [{ id: KEPT }];
    // At the new-visit limits, a kept visit still gets in: it is not a new visit.
    state.perAddress = flags.judgeAccess.sessionsPerIpPerHour;
    state.perHour = flags.judgeAccess.sessionsPerHour;
    state.perDay = flags.judgeAccess.sessionsPerDay;
    expect(await run()).toBe("/");
    expect(state.writes).toEqual([]);
    expect(state.set.map((c) => [c.name, c.value])).toEqual([
      ["pc_session", TOKEN],
      ["pc_demo", KEPT],
    ]);
    expect(info).toHaveBeenCalledWith("demo sign-in: visit kept");
  });

  it("starts a new visit when the held one has ended", async () => {
    state.cookies = { pc_demo: KEPT };
    state.live = [];
    expect(await run()).toBe("/");
    expect(state.writes).toHaveLength(1);
    expect(state.set[1].value).not.toBe(KEPT);
  });

  it("never reaches a write other than its own visit row", async () => {
    expect(await run()).toBe("/");
    expect(state.writes.map((w) => w.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO demo_sessions",
    ]);
  });
});
