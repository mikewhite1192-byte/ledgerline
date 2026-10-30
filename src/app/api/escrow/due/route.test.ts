import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET } from "./route";

// The escrow releases due route: a cross-site request is refused first, then the escrow release
// switch, then the login, each before anything is read. The list is read on the carrier's local
// date of the request; a refusal answers with its category only, anything thrown is unavailable
// (never its text), and nothing is cached.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
};

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listReleasesDue: vi.fn(),
  readTenantZone: vi.fn(),
  withSessionTenant: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/escrow/due", () => ({ listReleasesDue: mocks.listReleasesDue }));
vi.mock("@/lib/money/read", () => ({ readTenantZone: mocks.readTenantZone }));
vi.mock("@/lib/tenant/context", () => ({ withSessionTenant: mocks.withSessionTenant }));

const req = (site = "same-origin") =>
  new Request("https://app.example/api/escrow/due", { method: "GET", headers: { "Sec-Fetch-Site": site } });

const saved = structuredClone(flags.escrowRelease);
const DUE = { asOf: "2026-11-02", drivers: [], truncated: false };

beforeEach(() => {
  // 03:30 UTC on Nov 3 is still Nov 2 in Chicago: the list must be read on the carrier's date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T03:30:00.000Z"));
  flags.escrowRelease = { ...saved, enabled: true };
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.readTenantZone.mockReset().mockResolvedValue("America/Chicago");
  mocks.listReleasesDue.mockReset().mockResolvedValue(DUE);
  mocks.withSessionTenant.mockReset().mockImplementation((_s: Session, fn: (q: unknown) => Promise<unknown>) => fn({}));
});

afterEach(() => {
  flags.escrowRelease = structuredClone(saved);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/escrow/due", () => {
  it("answers the due list read on the carrier's local date, never cached", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, ...DUE });
    expect(mocks.withSessionTenant).toHaveBeenCalledWith(SESSION, expect.any(Function));
    expect(mocks.listReleasesDue).toHaveBeenCalledWith({}, "2026-11-02");
  });

  it("refuses a cross-site request before the switch, the login or any read", async () => {
    flags.escrowRelease = { ...saved, enabled: false };
    const res = await GET(req("cross-site"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.listReleasesDue).not.toHaveBeenCalled();
  });

  it("refuses while the escrow release switch is off, before the login or any read", async () => {
    flags.escrowRelease = { ...saved, enabled: false };
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.withSessionTenant).not.toHaveBeenCalled();
  });

  it("refuses a request with no login before any read", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.withSessionTenant).not.toHaveBeenCalled();
  });

  it("answers forbidden for a session with no membership here", async () => {
    const err = new Error("not a member");
    err.name = "ForbiddenError";
    mocks.withSessionTenant.mockRejectedValue(err);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
  });

  it("answers unavailable for a read that throws, never the error's text", async () => {
    mocks.listReleasesDue.mockRejectedValue(new Error("relation secret_table does not exist"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain("secret_table");
    expect(JSON.parse(body)).toEqual({ error: "unavailable", retryable: true });
  });
});
