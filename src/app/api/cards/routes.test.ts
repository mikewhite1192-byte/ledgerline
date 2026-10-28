import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { RunView } from "@/lib/data/card-recon";
import { POST as dismiss } from "./breaks/[id]/dismiss/route";
import { GET as readOne, POST as advance } from "./check/[runId]/route";
import { POST as start } from "./check/route";

// The card check routes' gates, with the check itself a stand-in: the cross-site check and the
// switch answer before any session is read, a bad id or body is refused before any read, and a
// failure answers a category, never the error's text. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const BREAK = "7c2d0e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const RUN_VIEW: RunView = {
  id: RUN,
  status: "running",
  phase: "records",
  failCategory: null,
  windowFrom: "2026-10-16",
  windowTo: "2026-10-29",
  counts: { statement: 168, records: 12, recordsClean: 9, needsYou: 3, notConfirmed: 1, explained: 2 },
  unchecked: [],
  modelCents: 0,
  startedAt: "2026-10-29T15:00:00.000Z",
  finishedAt: null,
};

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  startCardCheck: vi.fn(),
  advanceCardCheck: vi.fn(),
  dismissBreak: vi.fn(),
  readRun: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/recon/run", () => ({
  startCardCheck: mocks.startCardCheck,
  advanceCardCheck: mocks.advanceCardCheck,
  dismissBreak: mocks.dismissBreak,
}));
vi.mock("@/lib/data/card-recon", () => ({ readRun: mocks.readRun }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withSessionTenant: async <T,>(_s: Session, fn: (q: unknown) => Promise<T>) => fn({}),
}));

const saved = flags.cardRecon.enabled;

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://app.example${path}`, { headers });
const runParams = (runId: string) => ({ params: Promise.resolve({ runId }) });
const breakParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  flags.cardRecon.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.startCardCheck.mockResolvedValue({ ok: true, runId: RUN, resumed: false });
  mocks.advanceCardCheck.mockResolvedValue({ ok: true, run: RUN_VIEW });
  mocks.dismissBreak.mockResolvedValue({ ok: true });
  mocks.readRun.mockResolvedValue(RUN_VIEW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.cardRecon.enabled = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/cards/check", () => {
  it("opens a check, runs its first slice and answers its counts only", async () => {
    const res = await start(post("/api/cards/check", undefined, { "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      runId: RUN,
      status: "running",
      phase: "records",
      counts: { statement: 168, records: 12, recordsClean: 9, needsYou: 3, notConfirmed: 1 },
      resumed: false,
    });
    expect(mocks.startCardCheck).toHaveBeenCalledWith(SESSION);
    expect(mocks.advanceCardCheck).toHaveBeenCalledWith(SESSION, RUN, expect.any(Number));
  });

  it("refuses a cross-site request and a switched-off check before reading the session", async () => {
    expect((await start(post("/api/cards/check", undefined, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    flags.cardRecon.enabled = false;
    const off = await start(post("/api/cards/check"));
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "disabled" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.startCardCheck).not.toHaveBeenCalled();
  });

  it("answers 401 with no session, and the check's own refusal as its status", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await start(post("/api/cards/check"))).status).toBe(401);
    mocks.startCardCheck.mockResolvedValueOnce({ ok: false, category: "disabled" });
    expect((await start(post("/api/cards/check"))).status).toBe(404);
    mocks.advanceCardCheck.mockResolvedValueOnce({ ok: false, category: "not_found" });
    expect((await start(post("/api/cards/check"))).status).toBe(404);
  });

  it("answers a failure as unavailable, logging the error's name and never its text", async () => {
    mocks.startCardCheck.mockRejectedValueOnce(new Error("card 4417 row text"));
    const res = await start(post("/api/cards/check"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", retryable: true });
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("4417");
  });

  it("counts the first slice's deadline from the request's start, so opening the check uses up its time", async () => {
    const begun = 1_800_000_000_000;
    let now = begun;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.startCardCheck.mockImplementationOnce(async () => {
      now += 12_000;
      return { ok: true, runId: RUN, resumed: false };
    });
    expect((await start(post("/api/cards/check"))).status).toBe(202);
    expect(mocks.advanceCardCheck).toHaveBeenCalledWith(SESSION, RUN, begun + flags.cardRecon.limits.sliceMs);
  });

  it("answers a membership refusal as 403", async () => {
    const err = new Error("no membership");
    err.name = "ForbiddenError";
    mocks.startCardCheck.mockRejectedValueOnce(err);
    expect((await start(post("/api/cards/check"))).status).toBe(403);
  });
});

describe("/api/cards/check/[runId]", () => {
  it("POST runs one more slice of that check", async () => {
    const res = await advance(post(`/api/cards/check/${RUN}`), runParams(RUN));
    expect(res.status).toBe(200);
    expect((await res.json()).runId).toBe(RUN);
    expect(mocks.advanceCardCheck).toHaveBeenCalledWith(SESSION, RUN, expect.any(Number));
  });

  it("POST counts the slice's deadline from the request's start", async () => {
    const begun = 1_800_000_000_000;
    let now = begun;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.getSession.mockImplementationOnce(async () => {
      now += 3_000;
      return SESSION;
    });
    expect((await advance(post(`/api/cards/check/${RUN}`), runParams(RUN))).status).toBe(200);
    expect(mocks.advanceCardCheck).toHaveBeenCalledWith(SESSION, RUN, begun + flags.cardRecon.limits.sliceMs);
  });

  it("POST refuses cross-site, off, no session and a bad id, in that order, before any slice", async () => {
    expect((await advance(post(`/api/cards/check/${RUN}`, undefined, { "Sec-Fetch-Site": "cross-site" }), runParams(RUN))).status).toBe(403);
    flags.cardRecon.enabled = false;
    expect((await advance(post(`/api/cards/check/${RUN}`), runParams(RUN))).status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.cardRecon.enabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await advance(post(`/api/cards/check/${RUN}`), runParams(RUN))).status).toBe(401);
    const bad = await advance(post("/api/cards/check/not-a-run"), runParams("not-a-run"));
    expect(bad.status).toBe(400);
    expect(mocks.advanceCardCheck).not.toHaveBeenCalled();
  });

  it("GET reads where a check is, and a check that is not here is 404", async () => {
    const res = await readOne(get(`/api/cards/check/${RUN}`), runParams(RUN));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("running");
    mocks.readRun.mockResolvedValueOnce(null);
    expect((await readOne(get(`/api/cards/check/${RUN}`), runParams(RUN))).status).toBe(404);
    expect(mocks.advanceCardCheck).not.toHaveBeenCalled();
  });

  it("GET answers 404 while switched off, before the session", async () => {
    flags.cardRecon.enabled = false;
    expect((await readOne(get(`/api/cards/check/${RUN}`), runParams(RUN))).status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readRun).not.toHaveBeenCalled();
  });

  it("GET refuses a cross-site request before the switch and the session, and reads a same-site one", async () => {
    const cross = await readOne(get(`/api/cards/check/${RUN}`, { "Sec-Fetch-Site": "cross-site" }), runParams(RUN));
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: "forbidden" });
    flags.cardRecon.enabled = false;
    expect((await readOne(get(`/api/cards/check/${RUN}`, { "Sec-Fetch-Site": "same-site" }), runParams(RUN))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readRun).not.toHaveBeenCalled();
    flags.cardRecon.enabled = true;
    const same = await readOne(get(`/api/cards/check/${RUN}`, { "Sec-Fetch-Site": "same-origin" }), runParams(RUN));
    expect(same.status).toBe(200);
    expect(mocks.readRun).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cards/breaks/[id]/dismiss", () => {
  const call = (body: unknown, id = BREAK, headers: Record<string, string> = {}) =>
    dismiss(post(`/api/cards/breaks/${id}/dismiss`, body, headers), breakParams(id));

  it("closes one difference with a reason", async () => {
    const res = await call({ category: "explained" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.dismissBreak).toHaveBeenCalledWith(SESSION, BREAK, "explained");
  });

  it("refuses cross-site and switched off before the session", async () => {
    expect((await call({ category: "explained" }, BREAK, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    flags.cardRecon.enabled = false;
    expect((await call({ category: "explained" })).status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.dismissBreak).not.toHaveBeenCalled();
  });

  it("refuses a bad id or body before any write", async () => {
    expect((await call({ category: "explained" }, "nope")).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
    expect((await call([1, 2])).status).toBe(400);
    expect((await call({ category: 7 })).status).toBe(400);
    expect((await call({ category: "x".repeat(3_000) })).status).toBe(400);
    expect(mocks.dismissBreak).not.toHaveBeenCalled();
  });

  it("answers the dismissal's own refusal as its status", async () => {
    mocks.dismissBreak.mockResolvedValueOnce({ ok: false, category: "not_found" });
    expect((await call({ category: "explained" })).status).toBe(404);
    mocks.dismissBreak.mockResolvedValueOnce({ ok: false, category: "bad_request" });
    expect((await call({ category: "made_up" })).status).toBe(400);
  });
});
