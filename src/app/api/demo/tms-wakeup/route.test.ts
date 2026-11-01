import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// "Fire a wake-up twice"'s gates, with the database and the store stand-ins: the cross-site check
// and all three switches answer before the session is read, only an admin may fire it, a carrier
// with no mirrored load answers 404, and the same wake-up goes to the store twice, in two
// transactions, without waking the desk. The coalescing itself is proven against a real database
// in src/app/api/internal/tms-hook/[tenant]/route.db.test.ts. No database and no network here.

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  assertMembership: vi.fn(),
  staffGate: vi.fn(),
  readRole: vi.fn(),
  acceptWakeUp: vi.fn(),
  withTenant: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/auth/role", () => ({ readRole: mocks.readRole }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ withTenant: mocks.withTenant }) }));
vi.mock("@/lib/tms/wakeups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tms/wakeups")>()),
  acceptWakeUp: mocks.acceptWakeUp,
}));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  assertMembership: mocks.assertMembership,
}));

const saved = structuredClone(flags);

const call = (headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  POST(new Request("https://app.example/api/demo/tms-wakeup", { method: "POST", headers }));

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.tmsSync.demoFaultsEnabled = true;
  flags.tmsHook.enabled = true;
  flags.tmsSync.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.staffGate.mockResolvedValue(null);
  mocks.readRole.mockResolvedValue("admin");
  mocks.query.mockImplementation((sql: string) =>
    Promise.resolve(sql.includes("count(*)") ? [{ n: 1 }] : [{ external_id: "syn:demo:L-1001", reference: "L-1001" }]),
  );
  mocks.withTenant.mockImplementation((_t: string, fn: (q: unknown) => unknown) => fn({ query: mocks.query }));
  mocks.acceptWakeUp
    .mockResolvedValueOnce({ queued: "new", withinRate: true })
    .mockResolvedValueOnce({ queued: "coalesced", withinRate: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/demo/tms-wakeup", () => {
  it("sends the newest load's wake-up twice, in two transactions of the caller's own tenant, uncached", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ reference: "L-1001", first: "new", second: "coalesced", waiting: 1 });
    expect(mocks.withTenant.mock.calls.map((c) => c[0])).toEqual([TENANT, TENANT, TENANT, TENANT]);
    expect(mocks.assertMembership).toHaveBeenCalledTimes(4);
    expect(mocks.acceptWakeUp).toHaveBeenCalledTimes(2);
    const [a, b] = mocks.acceptWakeUp.mock.calls;
    expect(a[1]).toEqual({ recordType: "load", externalId: "syn:demo:L-1001" });
    expect(b[1]).toEqual(a[1]);
    expect(a[2].id).not.toBe(b[2].id);
    expect(a[2].perMinute).toBe(60);
  });

  it("answers 404 while any of its three switches is off, before reading the session", async () => {
    for (const off of ["demoFaultsEnabled", "hook", "sync"] as const) {
      Object.assign(flags, structuredClone(saved));
      flags.tmsSync.demoFaultsEnabled = off !== "demoFaultsEnabled";
      flags.tmsHook.enabled = off !== "hook";
      flags.tmsSync.enabled = off !== "sync";
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post, a signed-out caller and staff", async () => {
    expect((await call({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mocks.readRole.mockResolvedValueOnce("staff");
    const staff = await call();
    expect(staff.status).toBe(403);
    expect(await staff.json()).toMatchObject({ error: "role" });
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("answers 404 when the carrier has no mirrored load to wake", async () => {
    mocks.query.mockResolvedValue([]);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("answers an error as unavailable, with no text from it", async () => {
    mocks.acceptWakeUp.mockReset().mockRejectedValueOnce(new Error("relation tms_wakeups does not exist"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});
