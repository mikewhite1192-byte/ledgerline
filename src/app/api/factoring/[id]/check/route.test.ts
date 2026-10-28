import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The Check pending route's gates, with the check itself a stand-in: the cross-site check and the
// switch answer before any session is read, a refusal comes back as its category only, and an
// error's text never reaches the reply. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const SUMMARY = { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), checkPendingFactoring: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/factoring/execute", () => ({ checkPendingFactoring: mocks.checkPendingFactoring }));

const saved = flags.factoring.enabled;

const post = (id = REQUEST, headers: Record<string, string> = {}) =>
  POST(new Request(`https://app.example/api/factoring/${id}/check`, { method: "POST", headers }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  flags.factoring.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.checkPendingFactoring.mockResolvedValue({ ok: true, summary: SUMMARY, tooNew: 0, stillWaiting: 0, status: "funded" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.factoring.enabled = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/factoring/[id]/check", () => {
  it("checks the one request for the signed-in person and answers the counts", async () => {
    const res = await post(REQUEST.toUpperCase(), { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ summary: SUMMARY, tooNew: 0, stillWaiting: 0, status: "funded" });
    expect(mocks.checkPendingFactoring).toHaveBeenCalledTimes(1);
    expect(mocks.checkPendingFactoring.mock.calls[0]).toEqual([SESSION, REQUEST]);
  });

  it("refuses a cross-site post before reading the session", async () => {
    const res = await post(REQUEST, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.checkPendingFactoring).not.toHaveBeenCalled();
  });

  it("is not there with the switch off, before reading the session", async () => {
    flags.factoring.enabled = false;
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.checkPendingFactoring).not.toHaveBeenCalled();
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(401);
    expect(mocks.checkPendingFactoring).not.toHaveBeenCalled();
  });

  it("answers not found for an address that is not a request id, without checking", async () => {
    const res = await post("not-a-request");
    expect(res.status).toBe(404);
    expect(mocks.checkPendingFactoring).not.toHaveBeenCalled();
  });

  it("passes a refusal through as its category", async () => {
    mocks.checkPendingFactoring.mockResolvedValueOnce({ ok: false, category: "not_found", retryable: false });
    let res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", retryable: false });
    mocks.checkPendingFactoring.mockResolvedValueOnce({ ok: false, category: "factoring_not_armed", retryable: false });
    res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "factoring_not_armed", retryable: false });
  });

  it("answers forbidden for a person who is not a member", async () => {
    mocks.checkPendingFactoring.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "ForbiddenError" }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("answers unavailable on any other failure, with no error text in the reply or the log", async () => {
    mocks.checkPendingFactoring.mockRejectedValueOnce(new Error("row BR-INV-10240 for Blue Ridge"));
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(body)).not.toContain("BR-INV");
    expect(String(vi.mocked(console.error).mock.calls[0])).not.toContain("BR-INV");
  });
});
