import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { DemoResetFailed, DemoResetRefused, RESET_SQLSTATE, refusalText } from "@/lib/seed/reset";
import { resetDemoAction } from "./reset-action";

// The demo reset is for an admin of a demo carrier, with the switch on and the box ticked; every
// other case is refused before the reset runs, and every failure comes back as a category.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const [BR] = DEMO_CARRIERS;
const PLAN = { plan: "blue-ridge at the anchor" };

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
  demoCarrierOf: vi.fn(),
  resetDemoInTransaction: vi.fn(),
  buildCarrierPlan: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: mocks.getDb,
}));
vi.mock("@/lib/seed/plan", () => ({ buildCarrierPlan: mocks.buildCarrierPlan }));
vi.mock("@/lib/seed/reset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seed/reset")>()),
  demoCarrierOf: mocks.demoCarrierOf,
  resetDemoInTransaction: mocks.resetDemoInTransaction,
}));

// A membership table holding at most one row for the session's login; the reset itself is mocked.
function membership(role: "admin" | "staff" | null) {
  const q: Queryable = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!sql.includes("FROM memberships") || params[0] !== SESSION.sub || role === null) return [];
      return (sql.startsWith("SELECT role") ? [{ role }] : [{ ok: 1 }]) as T[];
    },
    async execute() {
      throw new Error("no writes expected outside the reset");
    },
  };
  mocks.getDb.mockReturnValue({
    withTenant: async <T>(tenantId: string, fn: (q: Queryable) => Promise<T>) => {
      expect(tenantId).toBe(SESSION.tenantId);
      return fn(q);
    },
  });
  return q;
}

const confirmed = (value = "reset") => {
  const form = new FormData();
  form.set("confirm", value);
  return form;
};

const REPORT = {
  slug: "blue-ridge",
  cleared: { money_actions: 3, driver_notes: 1, turn_steps: 3, advances: 1, proposals: 3, turns: 3, conversations: 3 },
  replaced: { deleted: { customers: 5 }, inserted: { customers: 5, drivers: 12, loads: 40 } },
  heroNetCents: 222_500,
};

beforeEach(() => {
  flags.demoResetEnabled = true;
  mocks.requireSession.mockResolvedValue(SESSION);
  mocks.demoCarrierOf.mockResolvedValue(BR);
  mocks.buildCarrierPlan.mockReturnValue(PLAN);
  mocks.resetDemoInTransaction.mockResolvedValue(REPORT);
});

afterEach(() => {
  flags.demoResetEnabled = false;
  vi.clearAllMocks();
});

describe("resetDemoAction", () => {
  it("resets the session's own demo carrier at the demo anchor, in the request's transaction", async () => {
    const q = membership("admin");
    expect(await resetDemoAction(null, confirmed())).toEqual({
      ok: true,
      carrier: "blue-ridge",
      cleared: 17,
      rewritten: 57,
      heroNetCents: 222_500,
    });
    expect(mocks.buildCarrierPlan).toHaveBeenCalledWith(BR, "2026-11-02");
    expect(mocks.resetDemoInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.resetDemoInTransaction).toHaveBeenCalledWith(q, PLAN);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/demo");
  });

  it("reads nothing while the switch is off", async () => {
    flags.demoResetEnabled = false;
    membership("admin");
    expect(await resetDemoAction(null, confirmed())).toEqual({ ok: false, category: "disabled" });
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.resetDemoInTransaction).not.toHaveBeenCalled();
  });

  it("reads nothing until the box is ticked", async () => {
    membership("admin");
    expect(await resetDemoAction(null, new FormData())).toEqual({ ok: false, category: "unconfirmed" });
    expect(await resetDemoAction(null, confirmed("yes"))).toEqual({ ok: false, category: "unconfirmed" });
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.resetDemoInTransaction).not.toHaveBeenCalled();
  });

  it("refuses a staff login and a login with no membership before the reset", async () => {
    for (const role of ["staff", null] as const) {
      membership(role);
      expect(await resetDemoAction(null, confirmed())).toEqual({ ok: false, category: "forbidden" });
    }
    expect(mocks.demoCarrierOf).not.toHaveBeenCalled();
    expect(mocks.resetDemoInTransaction).not.toHaveBeenCalled();
  });

  it("refuses a carrier that is not a demo carrier before the reset", async () => {
    membership("admin");
    mocks.demoCarrierOf.mockResolvedValue(null);
    expect(await resetDemoAction(null, confirmed())).toEqual({ ok: false, category: "not_demo" });
    expect(mocks.buildCarrierPlan).not.toHaveBeenCalled();
    expect(mocks.resetDemoInTransaction).not.toHaveBeenCalled();
  });

  it("names a refusal's counts and nothing else", async () => {
    membership("admin");
    const refusals = [
      { kind: "open", count: 1 },
      { kind: "flagged", count: 2 },
    ] as const;
    mocks.resetDemoInTransaction.mockRejectedValue(new DemoResetRefused([...refusals]));
    expect(await resetDemoAction(null, confirmed())).toEqual({
      ok: false,
      category: "refused",
      reasons: refusals.map(refusalText),
    });
  });

  it("returns categories for every failure, never database text", async () => {
    membership("admin");
    const cases: [unknown, string][] = [
      [new DemoResetFailed("drivers: the rows read back differ from the plan"), "failed"],
      [new DbError("sql", RESET_SQLSTATE.refused), "refused"],
      [new DbError("sql", RESET_SQLSTATE.notDemo), "not_demo"],
      [new DbError("unknown"), "unknown"],
      [new DbError("unavailable"), "unreadable"],
      [new DbError("sql", "23505"), "failed"],
    ];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [err, category] of cases) {
        mocks.resetDemoInTransaction.mockRejectedValueOnce(err);
        expect(await resetDemoAction(null, confirmed())).toEqual({ ok: false, category });
      }
    } finally {
      quiet.mockRestore();
    }
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(cases.length);
  });

  it("calls only an outage or a timeout unreadable; any other database error is a failed reset", async () => {
    membership("admin");
    const cases: [DbError, string, string][] = [
      [new DbError("resuming"), "unreadable", "demo reset: database resuming"],
      [new DbError("unavailable", "08006"), "unreadable", "demo reset: database unavailable 08006"],
      [new DbError("timeout", "57014"), "unreadable", "demo reset: database timeout 57014"],
      [new DbError("sql", "23505"), "failed", "demo reset: database sql 23505"],
      [new DbError("sql", "23503"), "failed", "demo reset: database sql 23503"],
      [new DbError("rls_denied", "42501"), "failed", "demo reset: database rls_denied 42501"],
      [new DbError("not_configured"), "failed", "demo reset: database not_configured"],
      [new DbError("unknown", "40001"), "unknown", "demo reset: database unknown 40001"],
    ];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [err, category, line] of cases) {
        logged.mockClear();
        mocks.resetDemoInTransaction.mockRejectedValueOnce(err);
        expect(await resetDemoAction(null, confirmed())).toEqual({ ok: false, category });
        // One line, the category and the SQLSTATE only.
        expect(logged.mock.calls).toEqual([[line]]);
      }
    } finally {
      logged.mockRestore();
    }
  });

  it("passes a signed-out redirect through untouched", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    mocks.requireSession.mockRejectedValue(redirect);
    membership("admin");
    await expect(resetDemoAction(null, confirmed())).rejects.toBe(redirect);
    expect(mocks.resetDemoInTransaction).not.toHaveBeenCalled();
  });
});
