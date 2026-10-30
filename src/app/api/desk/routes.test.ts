import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as internalDesk } from "../internal/desk/route";
import { POST as wakeNow } from "./wake/route";

// The desk routes' gates, with the loop itself a stand-in: the cross-site check and the switch
// answer before any key or session is read, the internal route never reads a person's session, and
// both run the loop as the carrier's sweep login. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const WAKE = "7c2d0e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const KEY = "Zk3".repeat(16);
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const SERVICE: Session = { sub: `service:sweep:${TENANT}`, email: "sweep@example.test", tenantId: TENANT };
const COUNTS = { seen: 2, claimed: 2, done: 2, carried: 0, skipped: 0, failed: 0, left: 0 };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  serviceSession: vi.fn(),
  internalKey: vi.fn(),
  wakeDesk: vi.fn(),
  assertMembership: vi.fn(),
  staffGate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here the caller is staff
// unless a test says it is a demo visitor.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ withTenant: (_t: string, fn: (q: unknown) => unknown) => fn({}) }) }));
vi.mock("@/lib/desk/loop", () => ({ wakeDesk: mocks.wakeDesk }));
vi.mock("@/lib/sweep/service-session", () => ({ serviceSession: mocks.serviceSession }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  assertMembership: mocks.assertMembership,
}));
vi.mock("@/lib/sweep/internal-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sweep/internal-key")>()),
  internalKey: mocks.internalKey,
}));

const saved = flags.deskLoop.enabled;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  flags.deskLoop.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.serviceSession.mockResolvedValue(SERVICE);
  mocks.internalKey.mockResolvedValue(KEY);
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.staffGate.mockResolvedValue(null);
  mocks.wakeDesk.mockResolvedValue({ ok: true, wakeId: WAKE, status: "done", reason: "no_work", counts: COUNTS });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.deskLoop.enabled = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/internal/desk", () => {
  const call = (body: unknown, key: string | null = KEY, extra: Record<string, string> = {}) =>
    internalDesk(post("/api/internal/desk", body, { ...(key === null ? {} : { "x-sweep-key": key }), ...extra }));

  it("wakes the carrier's loop as its sweep login for one slice, never a person's session", async () => {
    const before = Date.now();
    const res = await call({ action: "wake", tenantId: TENANT, wakeId: WAKE });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ wakeId: WAKE, status: "done", reason: "no_work", counts: COUNTS });
    const [session, input] = mocks.wakeDesk.mock.calls[0];
    expect(session).toBe(SERVICE);
    expect(input).toMatchObject({ wakeId: WAKE, by: "schedule" });
    expect(input.deadlineMs).toBeGreaterThanOrEqual(before + flags.deskLoop.limits.sliceMs);
    expect(input.deadlineMs).toBeLessThanOrEqual(Date.now() + flags.deskLoop.limits.sliceMs);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.staffGate).not.toHaveBeenCalled();
  });

  it("names a fresh wake when the kicker sends none, and answers busy and more as 200", async () => {
    mocks.wakeDesk.mockResolvedValueOnce({ ok: true, wakeId: WAKE, status: "busy", reason: null, counts: COUNTS });
    const busy = await call({ action: "wake", tenantId: TENANT });
    expect(busy.status).toBe(200);
    expect(await busy.json()).toMatchObject({ status: "busy" });
    expect(mocks.wakeDesk.mock.calls[0][1].wakeId).toMatch(/^[0-9a-f-]{36}$/);
    mocks.wakeDesk.mockResolvedValueOnce({ ok: true, wakeId: WAKE, status: "more", reason: "deadline", counts: COUNTS });
    expect(await (await call({ action: "wake", tenantId: TENANT })).json()).toMatchObject({ status: "more", reason: "deadline" });
  });

  it("answers 409 disabled while the loop is switched off, before reading the key or the body", async () => {
    flags.deskLoop.enabled = false;
    const res = await call("not an object", null);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "disabled", retryable: false });
    expect(mocks.internalKey).not.toHaveBeenCalled();
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request, a wrong key, and a missing key", async () => {
    expect((await call({ action: "wake", tenantId: TENANT }, KEY, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    for (const key of [null, "", `${KEY}x`]) {
      expect((await call({ action: "wake", tenantId: "acme" }, key)).status, String(key)).toBe(403);
    }
    mocks.internalKey.mockResolvedValueOnce(null);
    expect((await call({ action: "wake", tenantId: TENANT })).status).toBe(503);
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("takes a rotated key after one fresh read", async () => {
    const rotated = "Rq7".repeat(16);
    mocks.internalKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(rotated);
    expect((await call({ action: "wake", tenantId: TENANT }, rotated)).status).toBe(200);
    expect(mocks.internalKey.mock.calls[1][1]).toEqual({ fresh: true });
  });

  it("refuses a bad body and a carrier with no sweep login", async () => {
    for (const body of [
      { action: "wake", tenantId: "acme" },
      { action: "start", tenantId: TENANT },
      { action: "wake", tenantId: TENANT, wakeId: "wake-1" },
      [TENANT],
    ]) {
      expect((await call(body)).status, JSON.stringify(body)).toBe(400);
    }
    mocks.serviceSession.mockResolvedValueOnce(null);
    expect((await call({ action: "wake", tenantId: TENANT })).status).toBe(404);
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("answers a loop that could not read its state as 503 retryable, and a throw by its name only", async () => {
    mocks.wakeDesk.mockResolvedValueOnce({ ok: false, category: "unavailable" });
    const res = await call({ action: "wake", tenantId: TENANT });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", retryable: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.wakeDesk.mockRejectedValueOnce(new TypeError("row for driver Ana"));
    expect((await call({ action: "wake", tenantId: TENANT })).status).toBe(503);
    expect(error.mock.calls.flat().join(" ")).not.toContain("Ana");
  });
});

describe("POST /api/desk/wake", () => {
  const call = (headers: Record<string, string> = {}) => wakeNow(post("/api/desk/wake", {}, headers));

  it("wakes the loop for a signed-in member, as the carrier's sweep login, marked as the button", async () => {
    const res = await call({ "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", counts: COUNTS });
    expect(mocks.assertMembership).toHaveBeenCalledWith(expect.anything(), SESSION);
    expect(mocks.serviceSession).toHaveBeenCalledWith(expect.anything(), TENANT);
    expect(mocks.wakeDesk.mock.calls[0][0]).toBe(SERVICE);
    expect(mocks.wakeDesk.mock.calls[0][1]).toMatchObject({ by: "button" });
  });

  it("refuses cross-site and switched-off before reading the session, and no session with 401", async () => {
    expect((await call({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    flags.deskLoop.enabled = false;
    expect(await (await call()).json()).toMatchObject({ error: "disabled" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.deskLoop.enabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("refuses a demo visitor with the judge answer before any membership read or wake", async () => {
    mocks.staffGate.mockResolvedValueOnce(NextResponse.json({ error: "judge", retryable: false }, { status: 403 }));
    const res = await call({ "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.assertMembership).not.toHaveBeenCalled();
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
  });

  it("refuses a non-member, a carrier with no sweep login, and a loop another wake holds", async () => {
    const { ForbiddenError } = await import("@/lib/tenant/context");
    mocks.assertMembership.mockRejectedValueOnce(new ForbiddenError());
    expect((await call()).status).toBe(403);
    mocks.serviceSession.mockResolvedValueOnce(null);
    expect(await (await call()).json()).toMatchObject({ error: "not_configured" });
    expect(mocks.wakeDesk).not.toHaveBeenCalled();
    mocks.wakeDesk.mockResolvedValueOnce({ ok: true, wakeId: WAKE, status: "busy", reason: null, counts: COUNTS });
    const busy = await call();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "busy", retryable: true });
  });
});
