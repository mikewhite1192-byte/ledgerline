import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as approvePost } from "./[id]/approve/route";
import { POST as rejectPost } from "./[id]/reject/route";
import { POST as draftPost } from "./draft/route";

// The collections routes: a cross-site post is refused first, then the switch (404 before any
// read: no session, no database), then the login and the id, each before the service runs. A
// refusal answers with its category only; anything thrown is unavailable, never its text.

const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  draftCollections: vi.fn(),
  approveReminder: vi.fn(),
  rejectReminder: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/collections/draft", () => ({ draftCollections: mocks.draftCollections }));
vi.mock("@/lib/collections/decide", () => ({
  approveReminder: mocks.approveReminder,
  rejectReminder: mocks.rejectReminder,
}));

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function post(handler: Handler, id = ID, site = "same-origin") {
  const request = new Request("https://app.example/api/collections/x", {
    method: "POST",
    headers: { "content-type": "application/json", "Sec-Fetch-Site": site },
  });
  return handler(request, { params: Promise.resolve({ id }) });
}
const draft = (site = "same-origin") => post((r) => draftPost(r), ID, site);

const saved = { collections: flags.collectionsEnabled, ai: flags.aiEnabled };

beforeEach(() => {
  flags.collectionsEnabled = true;
  flags.aiEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.draftCollections.mockReset().mockResolvedValue({
    ok: true,
    drafted: 3,
    refused: 0,
    overCap: 0,
    skipped: 1,
    remaining: 0,
    stoppedBy: null,
    more: false,
    traceId: "33333333-3333-4333-8333-333333333333",
  });
  mocks.approveReminder.mockReset().mockResolvedValue({
    ok: true,
    status: "approved",
    channel: "logged",
    email: { sent: false, category: "disabled" },
  });
  mocks.rejectReminder.mockReset().mockResolvedValue({ ok: true, status: "rejected" });
});

afterEach(() => {
  flags.collectionsEnabled = saved.collections;
  flags.aiEnabled = saved.ai;
  vi.restoreAllMocks();
});

const nothingRan = () => {
  expect(mocks.getSession).not.toHaveBeenCalled();
  expect(mocks.draftCollections).not.toHaveBeenCalled();
  expect(mocks.approveReminder).not.toHaveBeenCalled();
  expect(mocks.rejectReminder).not.toHaveBeenCalled();
};

describe("collections routes", () => {
  it("flag off: routes answer 404 before any read", async () => {
    flags.collectionsEnabled = false;
    for (const res of [await draft(), await post(approvePost), await post(rejectPost)]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    nothingRan();
  });

  it("refuses a cross-site post first, even with the switch off", async () => {
    for (const on of [true, false]) {
      flags.collectionsEnabled = on;
      for (const res of [await draft("cross-site"), await post(approvePost, ID, "cross-site"), await post(rejectPost, ID, "cross-site")]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
    }
    nothingRan();
  });

  it("asks for a login, then a real id, before the service runs", async () => {
    mocks.getSession.mockResolvedValue(null);
    for (const res of [await draft(), await post(approvePost), await post(rejectPost)]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
    mocks.getSession.mockResolvedValue(SESSION);
    for (const handler of [approvePost, rejectPost]) {
      for (const id of ["not-a-uuid", "", `${ID}x`]) {
        const res = await post(handler, id);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "bad_request" });
      }
    }
    expect(mocks.draftCollections).not.toHaveBeenCalled();
    expect(mocks.approveReminder).not.toHaveBeenCalled();
    expect(mocks.rejectReminder).not.toHaveBeenCalled();
  });

  it("drafts only while the models are on, and never returns the run's trace id", async () => {
    flags.aiEnabled = false;
    const off = await draft();
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "ai_off" });
    expect(mocks.draftCollections).not.toHaveBeenCalled();

    flags.aiEnabled = true;
    const res = await draft();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, drafted: 3, refused: 0, overCap: 0, skipped: 1, remaining: 0, stoppedBy: null, more: false });
    expect(JSON.stringify(body)).not.toContain("33333333");
    expect(mocks.draftCollections).toHaveBeenCalledWith(SESSION, expect.any(Date));
  });

  it("maps the drafting code's own refusals", async () => {
    mocks.draftCollections.mockResolvedValueOnce({ ok: false, category: "disabled" });
    expect((await draft()).status).toBe(404);
    mocks.draftCollections.mockResolvedValueOnce({ ok: false, category: "ai_disabled" });
    const res = await draft();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ai_off" });
  });

  it("answers an approval with the email outcome as a category, and the refusals with theirs", async () => {
    const res = await post(approvePost);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "approved", channel: "logged", email: "would_send", category: "disabled" });
    expect(mocks.approveReminder).toHaveBeenCalledWith(SESSION, ID);

    mocks.approveReminder.mockResolvedValueOnce({ ok: true, status: "approved", channel: "email", email: { sent: true } });
    expect(await (await post(approvePost)).json()).toEqual({ ok: true, status: "approved", channel: "email", email: "sent", category: null });

    // An email that may or may not have gone out stays unknown, never "would send".
    mocks.approveReminder.mockResolvedValueOnce({
      ok: true,
      status: "approved",
      channel: "email",
      email: { sent: false, category: "unknown" },
    });
    expect(await (await post(approvePost)).json()).toEqual({
      ok: true,
      status: "approved",
      channel: "email",
      email: "unknown",
      category: "unknown",
    });

    for (const [category, status] of [
      ["paid_since", 409],
      ["changed", 409],
      ["stage_passed", 409],
      ["already_decided", 409],
      ["not_approvable", 409],
      ["not_found", 404],
    ] as const) {
      mocks.approveReminder.mockResolvedValueOnce({ ok: false, category });
      const r = await post(approvePost);
      expect(r.status, category).toBe(status);
      expect(await r.json()).toEqual({ error: category });
    }
    mocks.approveReminder.mockResolvedValueOnce({ ok: false, category: "disabled" });
    const off = await post(approvePost);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "not_found" });
  });

  it("answers a rejection and its refusals", async () => {
    const res = await post(rejectPost);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "rejected" });
    mocks.rejectReminder.mockResolvedValueOnce({ ok: false, category: "already_decided" });
    const again = await post(rejectPost);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_decided" });
  });

  it("answers forbidden for another carrier's login and unavailable for anything else, never the error text", async () => {
    const forbidden = Object.assign(new Error("secret detail"), { name: "ForbiddenError" });
    const boom = new Error("secret detail at db host");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [mock, call] of [
      [mocks.draftCollections, () => draft()],
      [mocks.approveReminder, () => post(approvePost)],
      [mocks.rejectReminder, () => post(rejectPost)],
    ] as const) {
      mock.mockRejectedValueOnce(forbidden);
      const f = await call();
      expect(f.status).toBe(403);
      expect(await f.json()).toEqual({ error: "forbidden" });
      mock.mockRejectedValueOnce(boom);
      const u = await call();
      expect(u.status).toBe(503);
      const text = JSON.stringify(await u.json());
      expect(text).toBe(JSON.stringify({ error: "unavailable" }));
    }
    for (const args of log.mock.calls) expect(args.join(" ")).not.toContain("secret detail");
  });
});
