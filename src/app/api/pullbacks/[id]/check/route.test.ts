import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The card pull-back check route: a cross-site post is refused first, then the card pull-back
// switch, then the login and the id in the path, each before the read-back runs. A refusal answers
// with its category only; anything thrown is unavailable, never its text; nothing is cached. The
// id carries hex letters, so a test of upper and lower case really changes it.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
};
const PULL = "eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  checkPendingPull: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/pullbacks/execute", () => ({ checkPendingPull: mocks.checkPendingPull }));

function req(site = "same-origin") {
  return new Request(`https://app.example/api/pullbacks/${PULL}/check`, {
    method: "POST",
    headers: { "content-type": "application/json", "Sec-Fetch-Site": site },
    body: "{}",
  });
}

const check = (id = PULL, site = "same-origin") => POST(req(site), { params: Promise.resolve({ id }) });

const saved = structuredClone(flags.cardPullback);
const CHECKED = {
  ok: true,
  summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 },
  tooNew: 0,
  stillWaiting: 0,
  needsPerson: false,
};

beforeEach(() => {
  flags.cardPullback = { ...saved, enabled: true };
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.checkPendingPull.mockReset().mockResolvedValue(CHECKED);
});

afterEach(() => {
  flags.cardPullback = structuredClone(saved);
  vi.restoreAllMocks();
});

describe("POST /api/pullbacks/[id]/check", () => {
  it("runs the read-back for a well-formed id, lower-cased, and answers its summary, never cached", async () => {
    expect(PULL.toUpperCase()).not.toBe(PULL);
    const res = await check(PULL.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(CHECKED);
    expect(mocks.checkPendingPull).toHaveBeenCalledWith(SESSION, PULL);
  });

  it("answers a pull left for a person as needing one, with nothing waiting on the provider", async () => {
    const held = { ...CHECKED, summary: { ...CHECKED.summary, checked: 0, confirmed: 0 }, needsPerson: true };
    mocks.checkPendingPull.mockResolvedValueOnce(held);
    const res = await check();
    expect([res.status, await res.json()]).toEqual([200, held]);
  });

  it("refuses a cross-site post before the switch, the login or the read-back", async () => {
    flags.cardPullback = { ...saved, enabled: false };
    const res = await check(PULL, "cross-site");
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden", retryable: false }]);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.checkPendingPull).not.toHaveBeenCalled();
  });

  it("refuses while the pull-back switch is off, before the login or the read-back", async () => {
    flags.cardPullback = { ...saved, enabled: false };
    const res = await check();
    expect([res.status, await res.json()]).toEqual([403, { error: "disabled", retryable: false }]);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.checkPendingPull).not.toHaveBeenCalled();
  });

  it("refuses no login and a bad id before the read-back runs", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const out = await check();
    expect([out.status, await out.json()]).toEqual([401, { error: "unauthenticated", retryable: false }]);
    for (const id of ["not-a-uuid", `${PULL}x`, ""]) {
      const res = await check(id);
      expect([res.status, await res.json()]).toEqual([400, { error: "bad_request", retryable: false }]);
    }
    expect(mocks.checkPendingPull).not.toHaveBeenCalled();
  });

  it("answers a refusal by its category", async () => {
    mocks.checkPendingPull.mockResolvedValueOnce({ ok: false, category: "not_found", retryable: false });
    const missing = await check();
    expect([missing.status, await missing.json()]).toEqual([404, { error: "not_found", retryable: false }]);
    mocks.checkPendingPull.mockResolvedValueOnce({ ok: false, category: "pullback_off", retryable: false });
    const off = await check();
    expect([off.status, await off.json()]).toEqual([409, { error: "pullback_off", retryable: false }]);
  });

  it("answers forbidden for a session with no membership here", async () => {
    const err = new Error("not a member");
    err.name = "ForbiddenError";
    mocks.checkPendingPull.mockRejectedValueOnce(err);
    const res = await check();
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden", retryable: false }]);
  });

  it("answers anything thrown as unavailable, never its text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.checkPendingPull.mockRejectedValueOnce(new Error("relation card_pullbacks secret detail"));
    const res = await check();
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
  });
});
