import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The reject route's own checks, in order: a cross-site post is refused before the session is
// read, then the login, the id and the strict body (a category from the fixed list only), each
// before any write. A refusal comes back as its category only.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rejectProposal: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/proposals/reject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/proposals/reject")>()),
  rejectProposal: mocks.rejectProposal,
}));

function reject(opts: { id?: string; body?: string; site?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  const request = new Request(`https://app.example/api/proposals/${id}/reject`, {
    method: "POST",
    headers,
    body: opts.body,
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.rejectProposal.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/proposals/:id/reject", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await reject({ site, body: '{"category":"other"}' });
      expect(response.status, site).toBe(403);
      expect(await response.json(), site).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.rejectProposal).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await reject({ site: "same-origin" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.rejectProposal).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const response = await reject({ id: "123" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(mocks.rejectProposal).not.toHaveBeenCalled();
  });

  it("refuses free text, a category not on the list, or broken JSON", async () => {
    for (const body of ['{"category":"other","note":"call me"}', '{"category":"made_up"}', "{"]) {
      const response = await reject({ body });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toEqual({ error: "bad_request" });
    }
    expect(mocks.rejectProposal).not.toHaveBeenCalled();
  });

  it("rejects with the chosen category, or other when none is given, never cached", async () => {
    mocks.rejectProposal.mockResolvedValue({ ok: true });
    const response = await reject({ site: "same-origin", body: '{"category":"wrong_amount"}' });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, status: "rejected" });
    expect(mocks.rejectProposal).toHaveBeenCalledWith(SESSION, ID, "wrong_amount");

    await reject();
    expect(mocks.rejectProposal).toHaveBeenLastCalledWith(SESSION, ID, "other");
  });

  it("maps not found to 404 and already decided to 409, the category only", async () => {
    mocks.rejectProposal.mockResolvedValueOnce({ ok: false, category: "not_found" });
    const missing = await reject();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    mocks.rejectProposal.mockResolvedValueOnce({ ok: false, category: "already_decided" });
    const decided = await reject();
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ error: "already_decided" });

    // Money already left for it: refused with the never-alone code.
    mocks.rejectProposal.mockResolvedValueOnce({ ok: false, category: "reject_after_money_moved" });
    const moved = await reject();
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "reject_after_money_moved" });
  });

  it("turns a membership refusal into 403 and any other error into 503 with no detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rejectProposal.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    const forbidden = await reject();
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });

    mocks.rejectProposal.mockRejectedValueOnce(new Error("connection reset by 10.0.0.1"));
    const failed = await reject();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.1");
  });
});
