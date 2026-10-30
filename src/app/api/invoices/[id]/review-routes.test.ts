import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { POST as markSentPost } from "./mark-sent/route";
import { POST as reviewPost } from "./review/route";

// The two review routes' own checks, in order: a cross-site post is refused before the session is
// read, then the login, the id and the strict body, each before anything is written. A refusal
// comes back as its category only, with a fixed HTTP status per category.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), markReviewed: vi.fn(), markSent: vi.fn(), getDb: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/invoices/review", () => ({ markReviewed: mocks.markReviewed, markSent: mocks.markSent }));

type Route = typeof reviewPost;
const ROUTES: [string, Route, ReturnType<typeof vi.fn>, string][] = [
  ["review", reviewPost, mocks.markReviewed, '{"note":"Checked the rate"}'],
  ["mark-sent", markSentPost, mocks.markSent, '{"sentOn":"2026-10-30"}'],
];

function call(route: Route, opts: { id?: string; body?: string; site?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  const request = new Request(`https://app.example/api/invoices/${id}/x`, { method: "POST", headers, body: opts.body });
  return route(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.getDb.mockReset().mockReturnValue({ tag: "db" });
  mocks.markReviewed.mockReset();
  mocks.markSent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ROUTES)("POST /api/invoices/:id/%s", (_name, route, write, goodBody) => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await call(route, { site, body: goodBody });
      expect(response.status, site).toBe(403);
      expect(await response.json(), site).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await call(route, { body: goodBody });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a uuid", async () => {
    const response = await call(route, { id: "not-a-uuid", body: goodBody });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses broken JSON, a non-object and an unknown key", async () => {
    for (const body of ["{", "[]", "null", '"x"', '{"amountCents":1}']) {
      const response = await call(route, { body });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toEqual({ error: "validation" });
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("passes the write through and returns whether it changed anything, never cached", async () => {
    write.mockResolvedValueOnce({ ok: true, changed: true }).mockResolvedValueOnce({ ok: true, changed: false });
    const first = await call(route, { site: "same-origin", body: goodBody });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ ok: true, changed: true });
    const again = await call(route, { body: goodBody });
    expect(await again.json()).toEqual({ ok: true, changed: false });
    const [db, session, id, value, now] = write.mock.calls[0];
    expect(db).toEqual({ tag: "db" });
    expect(session).toEqual(SESSION);
    expect(id).toBe(ID);
    expect(value).toBe(JSON.parse(goodBody)[Object.keys(JSON.parse(goodBody))[0]]);
    expect(now).toBeInstanceOf(Date);
  });

  it("maps each refusal category to its status, with the category only in the reply", async () => {
    const cases: [string, number][] = [
      ["validation", 400],
      ["disabled", 404],
      ["not_found", 404],
      ["not_posted", 409],
      ["not_ready", 409],
    ];
    for (const [category, status] of cases) {
      write.mockResolvedValueOnce({ ok: false, category });
      const response = await call(route, { body: goodBody });
      expect(response.status, category).toBe(status);
      expect(await response.json(), category).toEqual({ error: category });
    }
  });

  it("turns a membership refusal into 403 and any other error into a retryable 503 with no detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    write.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    const forbidden = await call(route, { body: goodBody });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });

    write.mockRejectedValueOnce(new Error("connection reset by 10.0.0.1"));
    const failed = await call(route, { body: goodBody });
    expect(failed.status).toBe(503);
    const body = await failed.json();
    expect(body).toEqual({ error: "unavailable", retryable: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.1");
  });
});

describe("POST /api/invoices/:id/review with no body", () => {
  it("is a review with no note", async () => {
    mocks.markReviewed.mockResolvedValueOnce({ ok: true, changed: true });
    const response = await call(reviewPost, {});
    expect(response.status).toBe(200);
    expect(mocks.markReviewed.mock.calls[0][3]).toBeUndefined();
  });
});
