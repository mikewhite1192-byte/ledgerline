import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Param, type Queryable } from "@/lib/db";
import { clearAlertAction } from "./clear-alert-action";

// The Clear button's server side: only an admin of the carrier clears a stopped job, inside the
// carrier's own transaction; anything else comes back as a category and nothing is cleared.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ALERT = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({
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

type Carrier = {
  role: "admin" | "staff" | null;
  // Rows the clear's UPDATE reports, and whether the alert is this carrier's at all.
  updated?: number;
  exists?: boolean;
  readFails?: boolean;
};

function carrier({ role, updated = 1, exists = true, readFails = false }: Carrier) {
  const writes: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (readFails) throw new DbError("unavailable");
      if (sql.includes("FROM memberships")) {
        if (role === null || params[0] !== SESSION.sub) return [];
        return (sql.startsWith("SELECT 1") ? [{ ok: 1 }] : [{ id: MEMBER, role }]) as T[];
      }
      if (sql.includes("FROM spend_alerts")) return (exists ? [{ id: ALERT }] : []) as T[];
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      writes.push({ sql, params });
      return updated;
    },
  };
  mocks.getDb.mockReturnValue({
    withTenant: async <T>(tenantId: string, fn: (q: Queryable) => Promise<T>) => {
      expect(tenantId).toBe(SESSION.tenantId);
      return fn(q);
    },
  });
  return writes;
}

const form = (alertId: unknown) => {
  const f = new FormData();
  if (typeof alertId === "string") f.set("alertId", alertId);
  return f;
};

beforeEach(() => {
  mocks.requireSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("clearAlertAction", () => {
  it("clears an open alert for an admin, recording who, with the database clock", async () => {
    const writes = carrier({ role: "admin" });
    expect(await clearAlertAction(null, form(ALERT))).toEqual({ ok: true, result: "cleared" });
    expect(writes).toHaveLength(1);
    expect(writes[0].params).toEqual([ALERT, null, MEMBER]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/models");
  });

  it("says when someone already cleared it", async () => {
    carrier({ role: "admin", updated: 0 });
    expect(await clearAlertAction(null, form(ALERT))).toEqual({ ok: true, result: "already_cleared" });
  });

  it("refuses staff and a login with no membership, clearing nothing", async () => {
    for (const role of ["staff", null] as const) {
      const writes = carrier({ role });
      expect(await clearAlertAction(null, form(ALERT))).toEqual({ ok: false, category: "forbidden" });
      expect(writes).toEqual([]);
    }
  });

  it("refuses an id that is not a uuid before opening a transaction", async () => {
    for (const bad of [undefined, "", "not-a-uuid", `${ALERT} OR 1=1`]) {
      expect(await clearAlertAction(null, form(bad))).toEqual({ ok: false, category: "invalid" });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("reports another carrier's alert, or a missing one, as not found", async () => {
    carrier({ role: "admin", updated: 0, exists: false });
    expect(await clearAlertAction(null, form(ALERT))).toEqual({ ok: false, category: "not_found" });
  });

  it("reports a database failure as a category and still refreshes the page", async () => {
    carrier({ role: "admin", readFails: true });
    expect(await clearAlertAction(null, form(ALERT))).toEqual({ ok: false, category: "unreadable" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/models");
  });
});
