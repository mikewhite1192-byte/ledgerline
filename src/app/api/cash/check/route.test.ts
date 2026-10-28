import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The check route's gates, with the check itself a stand-in: the cross-site check and the
// switch answer before any session is read, a refusal comes back as its category only, and an
// error's text never reaches the reply. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const CHECK = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), runCashCheck: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/cash/check", () => ({ runCashCheck: mocks.runCashCheck }));

const saved = { ...flags };

const post = (headers: Record<string, string> = {}) =>
  POST(new Request("https://app.example/api/cash/check", { method: "POST", headers }));

beforeEach(() => {
  flags.cashFridayEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.runCashCheck.mockResolvedValue({ ok: true, checkId: CHECK, gapCents: -680_000, options: [], explained: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags, saved);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/cash/check", () => {
  it("runs one check for the signed-in person and answers its id", async () => {
    const res = await post({ "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ checkId: CHECK });
    expect(mocks.runCashCheck).toHaveBeenCalledTimes(1);
    expect(mocks.runCashCheck.mock.calls[0][0]).toBe(SESSION);
  });

  it("refuses a cross-site post before reading the session", async () => {
    const res = await post({ "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runCashCheck).not.toHaveBeenCalled();
  });

  it("answers disabled with the switch off, before reading the session", async () => {
    flags.cashFridayEnabled = false;
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "disabled" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runCashCheck).not.toHaveBeenCalled();
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(401);
    expect(mocks.runCashCheck).not.toHaveBeenCalled();
  });

  it("passes the engine's refusal through as its category", async () => {
    for (const category of ["balance_missing", "more_than_one_open_period", "pay_run_unknown"]) {
      mocks.runCashCheck.mockResolvedValueOnce({ ok: false, category });
      const res = await post();
      expect(res.status, category).toBe(409);
      expect(await res.json()).toEqual({ error: category });
    }
  });

  it("answers forbidden for a person who is not a member", async () => {
    mocks.runCashCheck.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "ForbiddenError" }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("logs an error's name only and answers unavailable", async () => {
    mocks.runCashCheck.mockRejectedValueOnce(new TypeError("row BR-NTB-2229 for 888424 cents"));
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(body)).not.toContain("BR-NTB");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toBe("cash check failed: TypeError");
  });
});
