import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The load card route's own checks, in order, with the session, the staff check and the service
// faked: a cross-site post is refused before the session is read, then the login, both switches,
// the staff check and the id, each before the service runs. Replies carry categories only.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), createLoadCard: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/ratecon/service", () => ({ createLoadCard: mocks.createLoadCard }));

const VIEW = { documentId: ID, status: "proposed", category: null, proposalId: ID, attemptsLeft: 2 };

function post(opts: { site?: string; id?: string } = {}) {
  const headers: Record<string, string> = { "sec-fetch-site": opts.site ?? "same-origin" };
  return POST(new Request(`https://app.example/api/documents/${ID}/load`, { method: "POST", headers }), {
    params: Promise.resolve({ id: opts.id ?? ID }),
  });
}

const saved = { documents: flags.documentsEnabled, ratecon: { ...flags.ratecon } };
beforeEach(() => {
  flags.documentsEnabled = true;
  flags.ratecon = { ...flags.ratecon, enabled: true };
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.staffGate.mockReset().mockResolvedValue(null);
  mocks.createLoadCard.mockReset().mockResolvedValue({ ok: true, view: VIEW });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.documentsEnabled = saved.documents;
  flags.ratecon = { ...saved.ratecon };
  vi.restoreAllMocks();
});

describe("POST /api/documents/[id]/load", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await post({ site });
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(mocks.createLoadCard).not.toHaveBeenCalled();
  });

  it("answers not found while either switch is off, before the staff check", async () => {
    flags.ratecon = { ...flags.ratecon, enabled: false };
    let res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "disabled" });
    flags.ratecon = { ...flags.ratecon, enabled: true };
    flags.documentsEnabled = false;
    res = await post();
    expect(res.status).toBe(404);
    expect(mocks.staffGate).not.toHaveBeenCalled();
    expect(mocks.createLoadCard).not.toHaveBeenCalled();
  });

  it("refuses a demo visitor with the staff check's answer and runs nothing", async () => {
    mocks.staffGate.mockResolvedValue(NextResponse.json({ error: "judge", retryable: false }, { status: 403 }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.createLoadCard).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const res = await post({ id: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(mocks.createLoadCard).not.toHaveBeenCalled();
  });

  it("answers with the reading's view, never the reading", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ratecon: VIEW });
    expect(mocks.createLoadCard).toHaveBeenCalledWith(SESSION, ID);
  });

  it("maps each refusal to its status, as a category", async () => {
    const cases: [string, number][] = [
      ["not_found", 404],
      ["not_rate_confirmation", 409],
      ["has_record", 409],
      ["in_progress", 409],
      ["attempt_limit", 429],
      ["limit", 429],
    ];
    for (const [error, status] of cases) {
      mocks.createLoadCard.mockResolvedValue({ ok: false, error });
      const res = await post();
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("answers forbidden for a non-member and unavailable for anything else, with no error text", async () => {
    const forbidden = new Error("no membership in this tenant");
    forbidden.name = "ForbiddenError";
    mocks.createLoadCard.mockRejectedValueOnce(forbidden);
    let res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    mocks.createLoadCard.mockRejectedValueOnce(new Error("connection reset by 10.0.0.1"));
    res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});
