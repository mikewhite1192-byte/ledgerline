import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { NO_FAULTS } from "@/lib/adapters/tms-source/faults";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The dispatch fault switches route's gates, with the store a stand-in: the cross-site check and
// the switch answer before the session is read, only an admin may change a switch, the body must
// name known faults with boolean values only, and a carrier without the synthetic feed answers
// 404. The store's own tenant fence is proven against a real database in demo-faults.db.test.ts.
// No database and no network here.

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  assertMembership: vi.fn(),
  staffGate: vi.fn(),
  readRole: vi.fn(),
  saveDemoFaults: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/auth/role", () => ({ readRole: mocks.readRole }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ withTenant: mocks.withTenant }) }));
vi.mock("@/lib/tms/demo-faults", () => ({ saveDemoFaults: mocks.saveDemoFaults }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  assertMembership: mocks.assertMembership,
}));

const saved = flags.tmsSync.demoFaultsEnabled;

const call = (body: unknown, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  POST(
    new Request("https://app.example/api/demo/tms-faults", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  flags.tmsSync.demoFaultsEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.staffGate.mockResolvedValue(null);
  mocks.readRole.mockResolvedValue("admin");
  mocks.withTenant.mockImplementation((_t: string, fn: (q: unknown) => unknown) => fn({}));
  mocks.saveDemoFaults.mockImplementation((_q: unknown, change: Record<string, boolean>) =>
    Promise.resolve({ kind: "ok", faults: { ...NO_FAULTS, ...change } }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.tmsSync.demoFaultsEnabled = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/demo/tms-faults", () => {
  it("saves the change in the caller's own tenant and answers all nine switches, uncached", async () => {
    const res = await call({ hard_delete: true, clock_skew: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ faults: { ...NO_FAULTS, hard_delete: true } });
    expect(mocks.withTenant.mock.calls[0][0]).toBe(TENANT);
    expect(mocks.assertMembership).toHaveBeenCalledWith({}, SESSION);
    expect(mocks.saveDemoFaults).toHaveBeenCalledWith({}, { hard_delete: true, clock_skew: false });
  });

  it("answers 404 while the switch is off, before reading the session", async () => {
    flags.tmsSync.demoFaultsEnabled = false;
    const off = await call({ hard_delete: true });
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.saveDemoFaults).not.toHaveBeenCalled();
  });

  it("refuses cross-site, no session, a staff login and a judge", async () => {
    expect((await call({ hard_delete: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call({ hard_delete: true })).status).toBe(401);
    mocks.readRole.mockResolvedValue("staff");
    const staff = await call({ hard_delete: true });
    expect(staff.status).toBe(403);
    expect(await staff.json()).toMatchObject({ error: "role" });
    mocks.staffGate.mockResolvedValue(new Response(JSON.stringify({ error: "judge" }), { status: 403 }));
    const judge = await call({ hard_delete: true });
    expect(judge.status).toBe(403);
    expect(await judge.json()).toMatchObject({ error: "judge" });
    expect(mocks.saveDemoFaults).not.toHaveBeenCalled();
  });

  it("refuses an unknown fault, a non-boolean value, an empty body and a body that is not an object", async () => {
    for (const body of [
      { duplicate_wakeups: true },
      { hard_delete: true, not_a_fault: true },
      { hard_delete: "true" },
      { hard_delete: 1 },
      { hard_delete: null },
      {},
      [true],
      "not json",
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(mocks.saveDemoFaults).not.toHaveBeenCalled();
  });

  it("answers 404 when the carrier's connection is not the synthetic feed", async () => {
    mocks.saveDemoFaults.mockResolvedValue({ kind: "not_synthetic" });
    const res = await call({ hard_delete: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("answers a category for an error, never its text", async () => {
    mocks.saveDemoFaults.mockRejectedValue(new Error("row 42 secret text"));
    const err = await call({ hard_delete: true });
    expect(err.status).toBe(503);
    expect(JSON.stringify(await err.json())).not.toContain("secret");
  });
});
