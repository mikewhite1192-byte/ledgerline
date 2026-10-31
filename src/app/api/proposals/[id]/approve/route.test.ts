import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The approve route's own checks, in order: a cross-site post is refused before the session is
// read, then the login, the id and the strict body, each before any approval runs. A refusal from
// the gate comes back as its category only, with a fixed HTTP status per category.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), executeProposal: vi.fn(), answerAfterApprove: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/proposals/execute", () => ({ executeProposal: mocks.executeProposal }));
vi.mock("@/lib/asks/session", () => ({ answerAfterApprove: mocks.answerAfterApprove }));

function approve(opts: { id?: string; body?: string; site?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  const request = new Request(`https://app.example/api/proposals/${id}/approve`, {
    method: "POST",
    headers,
    body: opts.body,
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.executeProposal.mockReset();
  mocks.answerAfterApprove.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/proposals/:id/approve", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await approve({ site, body: "{}" });
      expect(response.status, site).toBe(403);
      expect(await response.json(), site).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.executeProposal).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await approve({ site: "same-origin", body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.executeProposal).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const response = await approve({ id: "not-a-uuid", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(mocks.executeProposal).not.toHaveBeenCalled();
  });

  it("refuses a body with an unknown key, a wrong type or broken JSON", async () => {
    for (const body of [
      '{"confirmed":true,"amountCents":1}',
      '{"confirmed":"yes"}',
      "{",
      "[]",
      '{"confirmed":true,"overrideReason":"too short"}',
      '{"confirmed":true,"auditedAt":"yesterday"}',
    ]) {
      const response = await approve({ body });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toEqual({ error: "bad_request" });
    }
    expect(mocks.executeProposal).not.toHaveBeenCalled();
  });

  it("passes the second confirm through and returns the result, never cached", async () => {
    mocks.executeProposal.mockResolvedValue({ ok: true, proposalId: ID, status: "confirmed", moneyActionId: null });
    const response = await approve({ site: "same-origin", body: '{"confirmed":true}' });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, proposalId: ID, status: "confirmed", moneyActionId: null });
    expect(mocks.executeProposal).toHaveBeenCalledWith(SESSION, ID, { confirmed: true, overrideReason: null, auditedAt: null });

    await approve();
    expect(mocks.executeProposal).toHaveBeenLastCalledWith(SESSION, ID, {
      confirmed: false,
      overrideReason: null,
      auditedAt: null,
    });

    // An override reason (trimmed) and the audit instant the card showed go through to the gate.
    const auditedAt = "2026-11-02T15:30:00.000Z";
    await approve({
      body: JSON.stringify({ confirmed: true, overrideReason: "  Driver showed the receipt  ", auditedAt }),
    });
    expect(mocks.executeProposal).toHaveBeenLastCalledWith(SESSION, ID, {
      confirmed: true,
      overrideReason: "Driver showed the receipt",
      auditedAt,
    });
  });

  it("marks the agent's question answered only after the approval went through", async () => {
    mocks.executeProposal.mockResolvedValueOnce({ ok: false, category: "needs_confirm", retryable: false });
    expect((await approve({ body: "{}" })).status).toBe(409);
    mocks.executeProposal.mockRejectedValueOnce(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await approve({ body: "{}" })).status).toBe(503);
    expect(mocks.answerAfterApprove).not.toHaveBeenCalled();

    const order: string[] = [];
    mocks.executeProposal.mockImplementationOnce(async () => {
      order.push("approve");
      return { ok: true, proposalId: ID, status: "done", moneyActionId: null };
    });
    mocks.answerAfterApprove.mockImplementationOnce(async () => {
      order.push("answered");
    });
    expect((await approve({ body: '{"confirmed":true}' })).status).toBe(200);
    expect(order).toEqual(["approve", "answered"]);
    expect(mocks.answerAfterApprove).toHaveBeenCalledWith(SESSION, ID);
  });

  it("maps each refusal category to its status, with the category only in the reply", async () => {
    const cases: [string, number][] = [
      ["role", 403],
      ["not_found", 404],
      ["not_executable", 409],
      ["already_decided", 409],
      ["expired", 409],
      ["auditor_required", 409],
      ["not_auditable", 409],
      ["override_required", 409],
      ["engine_override_required", 409],
      ["stale", 409],
      ["needs_confirm", 409],
    ];
    for (const [category, status] of cases) {
      mocks.executeProposal.mockResolvedValueOnce({ ok: false, category, retryable: false });
      const response = await approve();
      expect(response.status, category).toBe(status);
      expect(await response.json(), category).toEqual({ error: category, retryable: false });
    }
  });

  it("turns a membership refusal into 403 and any other error into a retryable 503 with no detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.executeProposal.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    const forbidden = await approve();
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });

    mocks.executeProposal.mockRejectedValueOnce(new Error("connection reset by 10.0.0.1"));
    const failed = await approve();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.1");
  });
});
