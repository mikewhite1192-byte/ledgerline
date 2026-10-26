import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { proofCallAction } from "./ai-proof-action";

// The model check is for carrier admins only: a staff login, or one with no membership, is
// refused before any model call or reservation, and a failed role read fails closed.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  requireSession: vi.fn(),
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: mocks.getDb,
}));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  complete: mocks.complete,
}));

// A membership table holding at most one row for the session's login. roleReadFails: the
// membership check passes and the role read after it fails.
function membership(role: "admin" | "staff" | null, roleReadFails = false) {
  const seen: string[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      seen.push(sql);
      if (roleReadFails && sql.startsWith("SELECT role")) throw new DbError("unavailable");
      if (!sql.includes("FROM memberships") || params[0] !== SESSION.sub) return [];
      if (role === null) return [];
      return (sql.startsWith("SELECT role") ? [{ role }] : [{ ok: 1 }]) as T[];
    },
    async execute() {
      throw new Error("no writes expected");
    },
  };
  mocks.getDb.mockReturnValue({
    withTenant: async <T>(tenantId: string, fn: (q: Queryable) => Promise<T>) => {
      expect(tenantId).toBe(SESSION.tenantId);
      return fn(q);
    },
  });
  return seen;
}

beforeEach(() => {
  flags.aiProofRoute = true;
  mocks.requireSession.mockResolvedValue(SESSION);
  mocks.complete.mockResolvedValue({ status: "ok", text: "Hello, money desk.", callId: "call-1" });
});

afterEach(() => {
  flags.aiProofRoute = false;
  vi.clearAllMocks();
});

describe("proofCallAction", () => {
  it("runs the check for an admin", async () => {
    const seen = membership("admin");
    expect(await proofCallAction()).toEqual({
      ok: true,
      text: "Hello, money desk.",
      callId: "call-1",
    });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0][0]).toBe("spark");
    expect(mocks.complete.mock.calls[0][2]).toEqual(SESSION);
    expect(seen.some((sql) => sql.startsWith("SELECT role FROM memberships"))).toBe(true);
  });

  it("refuses a staff login before any model call", async () => {
    membership("staff");
    expect(await proofCallAction()).toEqual({ ok: false, category: "forbidden" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("refuses a login with no membership in the token's carrier", async () => {
    membership(null);
    expect(await proofCallAction()).toEqual({ ok: false, category: "forbidden" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("fails closed when the role cannot be read, with no raw error text", async () => {
    membership("admin", true);
    expect(await proofCallAction()).toEqual({ ok: false, category: "unreadable" });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("reads nothing while the button's switch is off", async () => {
    flags.aiProofRoute = false;
    membership("admin");
    expect(await proofCallAction()).toEqual({ ok: false, category: "disabled" });
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("passes a signed-out redirect through untouched", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    mocks.requireSession.mockRejectedValue(redirect);
    membership("admin");
    await expect(proofCallAction()).rejects.toBe(redirect);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
