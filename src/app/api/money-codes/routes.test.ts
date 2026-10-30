import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as checkPost } from "./[id]/check/route";
import { POST as revealPost } from "./[id]/reveal/route";
import { POST as requestPost } from "./route";

// The money code routes: a cross-site post is refused first, then the money codes switch, the
// login, the id in the path and the strict body, each before the service runs. A refusal answers
// with its category only; anything thrown is unavailable, never its text; nothing is cached.
// The ids carry hex letters, so a test of upper and lower case really changes them.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
};
const CODE = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const LOAD = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
const DOC = "dddddddd-4444-4ddd-8ddd-dddddddddddd";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestMoneyCode: vi.fn(),
  checkPendingCode: vi.fn(),
  revealMoneyCode: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/money-codes/request", () => ({ requestMoneyCode: mocks.requestMoneyCode }));
vi.mock("@/lib/money-codes/execute", () => ({
  checkPendingCode: mocks.checkPendingCode,
  revealMoneyCode: mocks.revealMoneyCode,
}));

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function req(body: unknown, site = "same-origin") {
  return new Request("https://app.example/api/money-codes", {
    method: "POST",
    headers: { "content-type": "application/json", "Sec-Fetch-Site": site },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const onCode = (handler: Handler, id = CODE, site = "same-origin") => handler(req({}, site), { params: Promise.resolve({ id }) });

const saved = { ...flags.moneyCodes };

beforeEach(() => {
  flags.moneyCodes = { ...saved, enabled: true };
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.requestMoneyCode.mockReset().mockResolvedValue({ ok: true, outcome: "created", proposalId: CODE });
  mocks.checkPendingCode.mockReset().mockResolvedValue({
    ok: true,
    summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 },
    tooNew: 0,
    stillWaiting: 0,
  });
  mocks.revealMoneyCode.mockReset().mockResolvedValue({ ok: true, code: "0123456789", expiresAt: "2026-10-29T15:00:00.000Z" });
});

afterEach(() => {
  flags.moneyCodes = { ...saved };
  vi.restoreAllMocks();
});

const GOOD = { loadId: LOAD, amountCents: 15_000, purpose: "lumper", documentId: DOC };

describe("POST /api/money-codes", () => {
  it("passes a well-formed request on with its ids as sent and answers with the outcome, never cached", async () => {
    // The route takes an upper-case id as well-formed and hands it on unchanged; the service
    // lower-cases it (the database test of the request asks with upper-case ids).
    const upper = { ...GOOD, loadId: LOAD.toUpperCase(), documentId: DOC.toUpperCase() };
    expect([upper.loadId, upper.documentId]).not.toEqual([LOAD, DOC]);
    const res = await requestPost(req(upper));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, outcome: "created", proposalId: CODE });
    expect(mocks.requestMoneyCode).toHaveBeenCalledWith(SESSION, upper);
  });

  it("takes no receipt as null", async () => {
    await requestPost(req({ loadId: LOAD, amountCents: 15_000, purpose: "repair" }));
    expect(mocks.requestMoneyCode).toHaveBeenCalledWith(SESSION, { loadId: LOAD, amountCents: 15_000, purpose: "repair", documentId: null });
  });

  it("refuses cross-site first, then the switch, then the login, each before the service runs", async () => {
    expect((await requestPost(req(GOOD, "cross-site"))).status).toBe(403);
    flags.moneyCodes = { ...saved, enabled: false };
    const off = await requestPost(req(GOOD));
    expect([off.status, await off.json()]).toEqual([403, { error: "disabled", retryable: false }]);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.moneyCodes = { ...saved, enabled: true };
    mocks.getSession.mockResolvedValue(null);
    expect((await requestPost(req(GOOD))).status).toBe(401);
    expect(mocks.requestMoneyCode).not.toHaveBeenCalled();
  });

  it("refuses a body that is not exactly the form's fields", async () => {
    for (const body of [
      "not json",
      { ...GOOD, amountCents: 150.5 },
      { ...GOOD, amountCents: 0 },
      { ...GOOD, purpose: "fuel" },
      { ...GOOD, loadId: "BR-L10327" },
      { ...GOOD, driverId: LOAD },
      { ...GOOD, amountCents: "15000" },
    ]) {
      const res = await requestPost(req(body));
      expect([res.status, await res.json()]).toEqual([400, { error: "bad_request", retryable: false }]);
    }
    expect(mocks.requestMoneyCode).not.toHaveBeenCalled();
  });

  it("answers a refusal by its category and anything thrown as unavailable, never its text", async () => {
    mocks.requestMoneyCode.mockResolvedValueOnce({ ok: false, category: "receipt_total_differs", retryable: false });
    const refused = await requestPost(req(GOOD));
    expect([refused.status, await refused.json()]).toEqual([409, { error: "receipt_total_differs", retryable: false }]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.requestMoneyCode.mockRejectedValueOnce(new Error("relation money_codes secret detail"));
    const thrown = await requestPost(req(GOOD));
    const text = await thrown.text();
    expect(thrown.status).toBe(503);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
  });
});

describe("POST /api/money-codes/[id]/check and /reveal", () => {
  it("runs each for a well-formed id, lower-cased", async () => {
    expect(CODE.toUpperCase()).not.toBe(CODE);
    const checked = await onCode(checkPost, CODE.toUpperCase());
    expect(checked.status).toBe(200);
    expect(mocks.checkPendingCode).toHaveBeenCalledWith(SESSION, CODE);
    const shown = await onCode(revealPost, CODE.toUpperCase());
    expect(shown.status).toBe(200);
    expect(mocks.revealMoneyCode).toHaveBeenCalledWith(SESSION, CODE);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.json()).toEqual({ ok: true, code: "0123456789", expiresAt: "2026-10-29T15:00:00.000Z" });
  });

  it("refuses cross-site, the switch off, no login and a bad id before the service runs", async () => {
    for (const handler of [checkPost, revealPost]) {
      expect((await onCode(handler, CODE, "cross-site")).status).toBe(403);
      flags.moneyCodes = { ...saved, enabled: false };
      expect((await onCode(handler)).status).toBe(403);
      flags.moneyCodes = { ...saved, enabled: true };
      mocks.getSession.mockResolvedValueOnce(null);
      expect((await onCode(handler)).status).toBe(401);
      expect((await onCode(handler, "not-a-uuid")).status).toBe(400);
    }
    expect(mocks.checkPendingCode).not.toHaveBeenCalled();
    expect(mocks.revealMoneyCode).not.toHaveBeenCalled();
  });

  it("answers a reveal refusal by its category, with no code", async () => {
    mocks.revealMoneyCode.mockResolvedValueOnce({ ok: false, category: "code_expired", retryable: false });
    const res = await onCode(revealPost);
    expect([res.status, await res.json()]).toEqual([409, { error: "code_expired", retryable: false }]);
    mocks.revealMoneyCode.mockResolvedValueOnce({ ok: false, category: "not_found", retryable: false });
    expect((await onCode(revealPost)).status).toBe(404);
  });
});
