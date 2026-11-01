import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The dispatch webhook's gates, with the store and the desk stand-ins: the cross-site check and
// both switches answer before the key is read, a missing key fails closed, the token is checked
// (one fresh re-read) before the tenant or the body, the body is capped and read for two fields
// only, a carrier without its service login is refused, the rate bound answers 429 with the
// wake-up still kept, and replies carry a category only. The store and the lease against a real
// database are in route.db.test.ts. No database and no network here.

const TENANT = "11111111-1111-4111-8111-111111111111";
const KEY = "Hk7".repeat(16);
const SERVICE: Session = { sub: `service:sweep:${TENANT}`, email: "sweep@example.test", tenantId: TENANT };
const BODY = { recordType: "load", externalId: "syn:demo:L-1001", note: "ignored" };

const mocks = vi.hoisted(() => ({
  tmsHookKey: vi.fn(),
  serviceSession: vi.fn(),
  acceptWakeUp: vi.fn(),
  wakeDesk: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({}),
}));
vi.mock("@/lib/sweep/service-session", () => ({ serviceSession: mocks.serviceSession }));
vi.mock("@/lib/tms/hook-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tms/hook-key")>()),
  tmsHookKey: mocks.tmsHookKey,
}));
vi.mock("@/lib/tms/wakeups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tms/wakeups")>()),
  acceptWakeUp: mocks.acceptWakeUp,
}));
vi.mock("@/lib/desk/loop", () => ({ wakeDesk: mocks.wakeDesk }));
vi.mock("@/lib/tenant/context", () => ({
  withSessionTenant: async (_s: Session, fn: (q: unknown) => Promise<unknown>) => fn({}),
}));

const saved = structuredClone(flags);
let logged: string[] = [];

function post(
  body: unknown,
  opts: { token?: string | null; tenant?: string; headers?: Record<string, string> } = {},
): [Request, { params: Promise<{ tenant: string }> }] {
  const tenant = opts.tenant ?? TENANT;
  const token = opts.token === undefined ? KEY : opts.token;
  const url = `https://app.example/api/internal/tms-hook/${tenant}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`;
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return [request, { params: Promise.resolve({ tenant }) }];
}

const call = (body: unknown, opts: Parameters<typeof post>[1] = {}) => POST(...post(body, opts));

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.tmsHook.enabled = true;
  flags.tmsSync.enabled = true;
  mocks.tmsHookKey.mockReset().mockResolvedValue(KEY);
  mocks.serviceSession.mockReset().mockResolvedValue(SERVICE);
  mocks.acceptWakeUp.mockReset().mockResolvedValue({ queued: "new", withinRate: true });
  mocks.wakeDesk.mockReset().mockResolvedValue({ ok: true, wakeId: "w", status: "done", reason: null, counts: {} });
  logged = [];
  for (const level of ["error", "info", "log", "warn"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  for (const line of logged) {
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("token");
    expect(line).not.toContain("L-1001");
  }
  vi.restoreAllMocks();
});

describe("POST /api/internal/tms-hook/[tenant]", () => {
  it("keeps the wake-up for the named record and wakes the desk by the webhook, uncached", async () => {
    const res = await call(BODY);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ queued: "new", wake: "done" });
    expect(mocks.serviceSession).toHaveBeenCalledWith({}, TENANT);
    const [, wakeUp, input] = mocks.acceptWakeUp.mock.calls[0];
    // Only the two fields are read; the rest of the body is dropped unread.
    expect(wakeUp).toEqual({ recordType: "load", externalId: "syn:demo:L-1001" });
    expect(input).toMatchObject({ perMinute: 60 });
    const [session, wake] = mocks.wakeDesk.mock.calls[0];
    expect(session).toBe(SERVICE);
    expect(wake).toMatchObject({ by: "webhook" });
  });

  it("answers the wake's own word when the desk is busy or off, with the wake-up still kept", async () => {
    mocks.wakeDesk.mockResolvedValueOnce({ ok: true, wakeId: "w", status: "busy", reason: null, counts: {} });
    expect(await (await call(BODY)).json()).toEqual({ queued: "new", wake: "busy" });
    mocks.acceptWakeUp.mockResolvedValueOnce({ queued: "coalesced", withinRate: true });
    mocks.wakeDesk.mockResolvedValueOnce({ ok: false, category: "disabled" });
    const off = await call(BODY);
    expect(off.status).toBe(202);
    expect(await off.json()).toEqual({ queued: "coalesced", wake: "disabled" });
  });

  it("answers 409 while either switch is off, before reading the key", async () => {
    for (const off of ["hook", "sync"] as const) {
      flags.tmsHook.enabled = off !== "hook";
      flags.tmsSync.enabled = off !== "sync";
      const res = await call(BODY);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    }
    expect(mocks.tmsHookKey).not.toHaveBeenCalled();
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("fails closed with no key stored, or a key that cannot be read, and wakes nothing", async () => {
    mocks.tmsHookKey.mockResolvedValueOnce(null);
    const missing = await call(BODY);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "not_configured", retryable: true });
    mocks.tmsHookKey.mockRejectedValueOnce(new Error("AccessDenied for payday-copilot/tms-hook-key"));
    expect((await call(BODY)).status).toBe(503);
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing token with 403 after one fresh read, before the tenant is looked up", async () => {
    for (const token of ["Wr0".repeat(16), null, `${KEY}x`, KEY.slice(1)]) {
      mocks.tmsHookKey.mockClear();
      const res = await call(BODY, { token });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect(mocks.tmsHookKey).toHaveBeenCalledTimes(2);
      expect(mocks.tmsHookKey.mock.calls[1]).toEqual([{}, { fresh: true }]);
    }
    // A wrong token for a carrier that does not exist answers the same.
    const nobody = await call(BODY, { token: "Wr0".repeat(16), tenant: "22222222-2222-4222-8222-222222222222" });
    expect(nobody.status).toBe(403);
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("takes a rotated key on the fresh read", async () => {
    const rotated = "Nw9".repeat(16);
    mocks.tmsHookKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(rotated);
    expect((await call(BODY, { token: rotated })).status).toBe(202);
  });

  it("refuses a tenant that is not a uuid, and a carrier without its service login, as not found", async () => {
    const bad = await call(BODY, { tenant: "not-a-tenant" });
    expect(bad.status).toBe(404);
    mocks.serviceSession.mockResolvedValueOnce(null);
    const none = await call(BODY);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "not_found", retryable: false });
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("refuses a body over 4 KB with 413, read no further", async () => {
    const res = await call({ ...BODY, pad: "x".repeat(4_200) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_long", retryable: false });
    expect(mocks.serviceSession).not.toHaveBeenCalled();
  });

  it("refuses an unknown record type, an id out of bounds, bad JSON and an array as bad requests", async () => {
    for (const body of [
      { recordType: "truck", externalId: "T-1" },
      { recordType: "invoice", externalId: "I-1" },
      { recordType: "load", externalId: "has space" },
      { recordType: "load", externalId: "x".repeat(65) },
      { recordType: "load" },
      "{not json",
      [BODY],
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", retryable: false });
    }
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("answers 429 over the minute's bound, or with no room left, keeping the wake-up and waking nothing", async () => {
    mocks.acceptWakeUp.mockResolvedValueOnce({ queued: "coalesced", withinRate: false });
    const over = await call(BODY);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited", retryable: true });
    mocks.acceptWakeUp.mockResolvedValueOnce({ queued: "full", withinRate: true });
    expect((await call(BODY)).status).toBe(429);
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("refuses a bound that is not a whole number above zero as not configured", async () => {
    flags.tmsHook.hookPerMinute = 0;
    expect((await call(BODY)).status).toBe(503);
    flags.tmsHook.hookPerMinute = 1.5;
    expect((await call(BODY)).status).toBe(503);
    expect(mocks.acceptWakeUp).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before anything else", async () => {
    const res = await call(BODY, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(mocks.tmsHookKey).not.toHaveBeenCalled();
  });

  it("answers an error as unavailable, logging its name only", async () => {
    mocks.acceptWakeUp.mockRejectedValueOnce(new Error("duplicate key value violates tms_wakeups_one_waiting"));
    const res = await call(BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", retryable: true });
    expect(logged.join("\n")).not.toContain("duplicate key");
    expect(logged.join("\n")).toContain("tms hook failed: Error");
  });
});
