import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The move route's own checks, in order: a cross-site post is refused before the session is read,
// then the login, the staff check, the id and the strict body, each before any write. The move
// runs under the caller's own session (its tenant, membership and staff role are checked inside
// staffMove; src/lib/loads/movement.db.test.ts covers that against a real database). A refusal
// comes back as its category only.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";
const DB = { marker: "db" };

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), staffMove: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/db", () => ({ getDb: () => DB }));
vi.mock("@/lib/loads/movement", () => ({ staffMove: mocks.staffMove }));

function move(opts: { id?: string; body?: string; site?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  const request = new Request(`https://app.example/api/loads/${id}/move`, {
    method: "POST",
    headers,
    body: opts.body ?? '{"to":"in_transit"}',
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

const savedCancel = structuredClone(flags.cancelledTrip);

beforeEach(() => {
  flags.cancelledTrip = structuredClone(savedCancel);
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.staffGate.mockReset().mockResolvedValue(null);
  mocks.staffMove.mockReset().mockResolvedValue({ ok: true, changed: true, to: "in_transit" });
});

afterEach(() => {
  flags.cancelledTrip = structuredClone(savedCancel);
  vi.restoreAllMocks();
});

describe("POST /api/loads/:id/move", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await move({ site });
      expect(response.status, site).toBe(403);
      expect(await response.json(), site).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await move({ site: "same-origin" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.staffGate).not.toHaveBeenCalled();
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("hands back the staff check's refusal and moves nothing", async () => {
    mocks.staffGate.mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const response = await move();
    expect(response.status).toBe(403);
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const response = await move({ id: "123" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("refuses broken JSON, an array, or any key but to", async () => {
    for (const body of ["{", "[]", "null", '{"to":"delivered","at":"2026-10-30"}']) {
      const response = await move({ body });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toEqual({ error: "validation" });
    }
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("moves under the caller's own session and tenant", async () => {
    const response = await move({ body: '{"to":"in_transit"}' });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, changed: true, to: "in_transit" });
    expect(mocks.staffMove).toHaveBeenCalledTimes(1);
    const [db, session, id, to, now] = mocks.staffMove.mock.calls[0];
    expect(db).toBe(DB);
    expect(session).toEqual(SESSION);
    expect(id).toBe(ID);
    expect(to).toBe("in_transit");
    expect(now).toBeInstanceOf(Date);
  });

  it("refuses a direct cancel as validation while the cancelled trip is off, before any move", async () => {
    flags.cancelledTrip = { enabled: false, startDate: "2026-11-02" };
    const response = await move({ body: '{"to":"cancelled"}' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "validation" });
    expect(mocks.staffMove).not.toHaveBeenCalled();
  });

  it("hands a cancel to the move under the caller's session while the cancelled trip is on", async () => {
    flags.cancelledTrip = { enabled: true, startDate: "2026-11-02" };
    mocks.staffMove.mockResolvedValueOnce({ ok: true, changed: true, to: "cancelled" });
    const response = await move({ body: '{"to":"cancelled"}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: true, to: "cancelled" });
    expect(mocks.staffMove).toHaveBeenCalledTimes(1);
    expect(mocks.staffMove.mock.calls[0][3]).toBe("cancelled");
  });

  it("maps each refusal category to its status", async () => {
    const cases: [string, number][] = [
      ["validation", 400],
      ["not_found", 404],
      ["wrong_status", 409],
      ["date_out_of_window", 409],
      ["no_driver", 409],
    ];
    for (const [category, status] of cases) {
      mocks.staffMove.mockResolvedValueOnce({ ok: false, category });
      const response = await move();
      expect(response.status, category).toBe(status);
      expect(await response.json(), category).toEqual({ error: category });
    }
  });

  it("answers a membership refusal 403 and anything else 503, with no detail", async () => {
    const forbidden = Object.assign(new Error("not a member of tenant x"), { name: "ForbiddenError" });
    mocks.staffMove.mockRejectedValueOnce(forbidden);
    const r1 = await move();
    expect(r1.status).toBe(403);
    expect(await r1.json()).toEqual({ error: "forbidden" });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.staffMove.mockRejectedValueOnce(new Error("connection to db.internal refused"));
    const r2 = await move();
    expect(r2.status).toBe(503);
    expect(await r2.json()).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("db.internal");
  });
});
