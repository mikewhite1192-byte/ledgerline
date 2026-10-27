import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { GET as connect } from "./connect/route";
import { POST as disconnect } from "./disconnect/route";

// The QuickBooks routes' Sec-Fetch-Site checks: a refused request answers 403 before the session
// is read or anything changes. The connect flow itself is a stand-in here; no request leaves this
// machine.

const SESSION: Session = {
  sub: "sub-test",
  email: "admin@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/adapters/accounting/qbo/connect", () => ({
  createQboConnect: () => ({ start: mocks.start, finish: mocks.finish, disconnect: mocks.disconnect }),
}));

const request = (path: string, method: string, site?: string) =>
  new Request(`https://app.example/api/qbo/${path}`, {
    method,
    headers: site === undefined ? undefined : { "Sec-Fetch-Site": site },
  });

beforeEach(() => {
  mocks.requireSession.mockResolvedValue(SESSION);
  mocks.start.mockResolvedValue({ ok: true, url: "https://appcenter.intuit.com/connect/oauth2?state=x" });
  mocks.disconnect.mockResolvedValue({ ok: true, revoked: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/qbo/disconnect", () => {
  it("disconnects for a post from the app's own page", async () => {
    const response = await disconnect(request("disconnect", "POST", "same-origin"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/accounting?qbo=disconnected");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("refuses a post with no Sec-Fetch-Site, or from anywhere else, before reading the session", async () => {
    for (const site of [undefined, "cross-site", "same-site", "none", ""]) {
      const response = await disconnect(request("disconnect", "POST", site));
      expect(response.status, String(site)).toBe(403);
      expect(response.headers.get("location"), String(site)).toBeNull();
    }
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});

describe("GET /api/qbo/connect", () => {
  it("starts from the settings page's link or a typed address", async () => {
    for (const site of ["same-origin", "none"]) {
      const response = await connect(request("connect", "GET", site));
      expect(response.status, site).toBe(302);
      expect(response.headers.get("location"), site).toMatch(/^https:\/\/appcenter\.intuit\.com\//);
    }
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("refuses a request with no Sec-Fetch-Site, or from another site, before a state is written", async () => {
    for (const site of [undefined, "cross-site", "same-site", ""]) {
      const response = await connect(request("connect", "GET", site));
      expect(response.status, String(site)).toBe(403);
      expect(response.headers.get("location"), String(site)).toBeNull();
    }
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
