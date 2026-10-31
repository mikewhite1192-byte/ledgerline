import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The Sync dispatch now route's gates, with the sync itself a stand-in: the cross-site check and
// the switch answer before the session is read, only an admin (the one role the page shows the
// button to) may run it, the pull runs as the carrier's sweep login (never the person's session),
// and a held lease answers busy. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const SERVICE: Session = { sub: `service:sweep:${TENANT}`, email: "sweep@example.test", tenantId: TENANT };
const COUNTS = { listed: 3, read: 2, written: 2, gone: 0, failed: 0, passComplete: true, listFailed: null, stopped: null };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  serviceSession: vi.fn(),
  syncDispatchNow: vi.fn(),
  assertMembership: vi.fn(),
  staffGate: vi.fn(),
  readRole: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/auth/role", () => ({ readRole: mocks.readRole }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ withTenant: (_t: string, fn: (q: unknown) => unknown) => fn({}) }) }));
vi.mock("@/lib/tms/sync", () => ({ syncDispatchNow: mocks.syncDispatchNow }));
vi.mock("@/lib/sweep/service-session", () => ({ serviceSession: mocks.serviceSession }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  assertMembership: mocks.assertMembership,
}));

const saved = flags.tmsSync.enabled;

const call = (headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  POST(new Request("https://app.example/api/demo/tms-sync", { method: "POST", headers }));

beforeEach(() => {
  flags.tmsSync.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.serviceSession.mockResolvedValue(SERVICE);
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.staffGate.mockResolvedValue(null);
  mocks.readRole.mockResolvedValue("admin");
  mocks.syncDispatchNow.mockResolvedValue({ ok: true, result: { ran: true, ...COUNTS } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.tmsSync.enabled = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/demo/tms-sync", () => {
  it("pulls once as the carrier's sweep login and answers the counts, uncached", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(COUNTS);
    expect(mocks.assertMembership).toHaveBeenCalledWith({}, SESSION);
    expect(mocks.readRole).toHaveBeenCalledWith({}, SESSION);
    const [, session] = mocks.syncDispatchNow.mock.calls[0];
    expect(session).toBe(SERVICE);
  });

  it("refuses cross-site and switched-off before reading the session, and no session with 401", async () => {
    expect((await call({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    flags.tmsSync.enabled = false;
    const off = await call();
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: "disabled" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.tmsSync.enabled = true;
    mocks.getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(mocks.syncDispatchNow).not.toHaveBeenCalled();
  });

  it("refuses a staff login and a judge, as the page shows neither of them the button", async () => {
    mocks.readRole.mockResolvedValue("staff");
    const staff = await call();
    expect(staff.status).toBe(403);
    expect(await staff.json()).toMatchObject({ error: "role" });
    mocks.readRole.mockResolvedValue("judge");
    expect((await call()).status).toBe(403);
    // A judge stops at the staff check itself, before the role is read.
    mocks.staffGate.mockResolvedValue(new Response(JSON.stringify({ error: "judge" }), { status: 403 }));
    const judge = await call();
    expect(judge.status).toBe(403);
    expect(await judge.json()).toMatchObject({ error: "judge" });
    expect(mocks.syncDispatchNow).not.toHaveBeenCalled();
  });

  it("stops at the staff check and when the carrier has no sweep login", async () => {
    mocks.staffGate.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await call()).status).toBe(403);
    mocks.staffGate.mockResolvedValue(null);
    mocks.serviceSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_configured" });
    expect(mocks.syncDispatchNow).not.toHaveBeenCalled();
  });

  it("answers busy while a wake holds the lease, and a category for an error, never its text", async () => {
    mocks.syncDispatchNow.mockResolvedValue({ ok: false, category: "busy" });
    const busy = await call();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "busy", retryable: true });
    mocks.syncDispatchNow.mockResolvedValue({ ok: true, result: { ran: false, category: "no_lease" } });
    expect(await (await call()).json()).toMatchObject({ error: "busy" });
    mocks.syncDispatchNow.mockRejectedValue(new Error("row 42 secret text"));
    const err = await call();
    expect(err.status).toBe(503);
    expect(JSON.stringify(await err.json())).not.toContain("secret");
  });
});
