import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as internalSweep } from "../internal/sweep/route";
import { POST as approveCleanRoute } from "./[id]/approve-clean/route";
import { POST as advance } from "./[id]/advance/route";
import { GET as readRun } from "./[id]/route";
import { GET as readTrace } from "./[id]/trace/[turnId]/route";
import { POST as start } from "./route";

// The sweep routes' gates, with the sweep itself a stand-in: the cross-site check and the switch
// answer before any session is read, the internal route never reads a person's session, and it
// reads its key only once both switches are on, then checks it before the body. No database and
// no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const KEY = "Zk3".repeat(16);
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const SERVICE: Session = { sub: `service:sweep:${TENANT}`, email: "sweep@example.test", tenantId: TENANT };
const STATE = { ok: true, runId: RUN, status: "done", phase: "done", counts: { found: 3 }, truncatedReason: null, failureCategory: null };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  startSweep: vi.fn(),
  advanceSweep: vi.fn(),
  serviceSession: vi.fn(),
  internalKey: vi.fn(),
  readSweepPage: vi.fn(),
  approveClean: vi.fn(),
  readSweepTurnTrace: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sweep/run", () => ({ startSweep: mocks.startSweep, advanceSweep: mocks.advanceSweep }));
vi.mock("@/lib/sweep/service-session", () => ({ serviceSession: mocks.serviceSession }));
vi.mock("@/lib/sweep/view", () => ({ readSweepPage: mocks.readSweepPage }));
vi.mock("@/lib/agent/gateway/store", () => ({ readSweepTurnTrace: mocks.readSweepTurnTrace }));
vi.mock("@/lib/sweep/internal-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sweep/internal-key")>()),
  internalKey: mocks.internalKey,
}));
vi.mock("@/lib/sweep/approve-clean", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sweep/approve-clean")>()),
  approveClean: mocks.approveClean,
}));

const saved = { ...flags };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  flags.sweepEnabled = true;
  flags.sweepScheduleEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.serviceSession.mockResolvedValue(SERVICE);
  mocks.internalKey.mockResolvedValue(KEY);
  mocks.startSweep.mockResolvedValue({ ok: true, runId: RUN, existing: false });
  mocks.advanceSweep.mockResolvedValue(STATE);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags, saved);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/internal/sweep", () => {
  const call = (body: unknown, key: string | null = KEY, extra: Record<string, string> = {}) =>
    internalSweep(post("/api/internal/sweep", body, { ...(key === null ? {} : { "x-sweep-key": key }), ...extra }));

  it("starts a scheduled sweep as the carrier's sweep login, never a person's session", async () => {
    const res = await call({ action: "start", tenantId: TENANT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ runId: RUN, existing: false });
    expect(mocks.serviceSession).toHaveBeenCalledWith(expect.anything(), TENANT);
    expect(mocks.startSweep.mock.calls[0][0]).toBe(SERVICE);
    expect(mocks.startSweep.mock.calls[0][1]).toMatchObject({ trigger: "schedule" });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("carries a run on one slice and answers its state", async () => {
    const res = await call({ action: "advance", tenantId: TENANT, runId: RUN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: RUN, status: "done" });
    expect(mocks.advanceSweep.mock.calls[0][0]).toBe(SERVICE);
  });

  it("refuses a wrong or missing key with 403 before the body", async () => {
    for (const key of [null, "", `${KEY}x`, KEY.slice(1)]) {
      const res = await call({ action: "start", tenantId: "not-a-tenant" }, key);
      expect(res.status, String(key)).toBe(403);
    }
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    expect(mocks.startSweep).not.toHaveBeenCalled();
  });

  it("reads the key once more on a mismatch, so a rotated key is taken", async () => {
    const rotated = "Rq7".repeat(16);
    mocks.internalKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(rotated);
    const res = await call({ action: "start", tenantId: TENANT }, rotated);
    expect(res.status).toBe(200);
    expect(mocks.internalKey).toHaveBeenCalledTimes(2);
    expect(mocks.internalKey.mock.calls[1][1]).toEqual({ fresh: true });
  });

  it("still refuses a wrong key after the second read, and when that read fails", async () => {
    const wrong = "Wx9".repeat(16);
    const res = await call({ action: "start", tenantId: TENANT }, wrong);
    expect(res.status).toBe(403);
    expect(mocks.internalKey).toHaveBeenCalledTimes(2);
    mocks.internalKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(null);
    expect((await call({ action: "start", tenantId: TENANT }, wrong)).status).toBe(403);
    mocks.internalKey.mockResolvedValueOnce(KEY).mockRejectedValueOnce(new Error("boom"));
    expect((await call({ action: "start", tenantId: TENANT }, wrong)).status).toBe(403);
    expect(mocks.startSweep).not.toHaveBeenCalled();
  });

  it("answers 503 not_configured when there is no key, and 403 for a cross-site request", async () => {
    mocks.internalKey.mockResolvedValueOnce(null);
    const missing = await call({ action: "start", tenantId: TENANT });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: "not_configured" });
    mocks.internalKey.mockRejectedValueOnce(new Error("boom"));
    expect((await call({ action: "start", tenantId: TENANT })).status).toBe(503);
    const cross = await call({ action: "start", tenantId: TENANT }, KEY, { "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(mocks.startSweep).not.toHaveBeenCalled();
  });

  it("answers 409 schedule_off while the schedule switch is off, and disabled while the sweep is off", async () => {
    flags.sweepScheduleEnabled = false;
    const off = await call({ action: "start", tenantId: TENANT });
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: "schedule_off" });
    flags.sweepScheduleEnabled = true;
    flags.sweepEnabled = false;
    const disabled = await call({ action: "start", tenantId: TENANT });
    expect(await disabled.json()).toMatchObject({ error: "disabled" });
    expect(mocks.startSweep).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("reads no key while either switch is off", async () => {
    flags.sweepScheduleEnabled = false;
    expect(await (await call({ action: "start", tenantId: TENANT }, null)).json()).toMatchObject({ error: "schedule_off" });
    flags.sweepScheduleEnabled = true;
    flags.sweepEnabled = false;
    expect(await (await call({ action: "start", tenantId: TENANT }, null)).json()).toMatchObject({ error: "disabled" });
    expect(mocks.internalKey).not.toHaveBeenCalled();
    expect(mocks.serviceSession).not.toHaveBeenCalled();
    flags.sweepEnabled = true;
    expect((await call({ action: "start", tenantId: TENANT })).status).toBe(200);
    expect(mocks.internalKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad body and a carrier with no sweep login", async () => {
    for (const body of [{ action: "start", tenantId: "acme" }, { action: "stop", tenantId: TENANT }, { action: "advance", tenantId: TENANT }]) {
      expect((await call(body)).status, JSON.stringify(body)).toBe(400);
    }
    mocks.serviceSession.mockResolvedValueOnce(null);
    expect((await call({ action: "start", tenantId: TENANT })).status).toBe(404);
    expect(mocks.startSweep).not.toHaveBeenCalled();
  });
});

describe("the person's sweep routes", () => {
  it("start the sweep and run its first slice", async () => {
    const res = await start(post("/api/sweeps", { runId: RUN }, { "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.startSweep.mock.calls[0][1]).toEqual({ runId: RUN, periodId: null, trigger: "button" });
  });

  it("answer 202 busy when another request holds the run", async () => {
    mocks.advanceSweep.mockResolvedValueOnce({ ok: false, category: "busy" });
    const res = await start(post("/api/sweeps", { runId: RUN }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: RUN, status: "running", busy: true });
  });

  it("refuse a cross-site request and a switched-off sweep before reading the session", async () => {
    const cross = { "Sec-Fetch-Site": "cross-site" };
    expect((await start(post("/api/sweeps", { runId: RUN }, cross))).status).toBe(403);
    expect((await advance(post(`/api/sweeps/${RUN}/advance`, {}, cross), params(RUN))).status).toBe(403);
    expect((await approveCleanRoute(post(`/api/sweeps/${RUN}/approve-clean`, {}, cross), params(RUN))).status).toBe(403);
    flags.sweepEnabled = false;
    for (const res of [
      await start(post("/api/sweeps", { runId: RUN })),
      await advance(post(`/api/sweeps/${RUN}/advance`, {}), params(RUN)),
      await approveCleanRoute(post(`/api/sweeps/${RUN}/approve-clean`, {}), params(RUN)),
      await readRun(new Request(`https://app.example/api/sweeps/${RUN}`), params(RUN)),
    ]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "disabled" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.startSweep).not.toHaveBeenCalled();
  });

  it("answer 401 signed out and 400 for a bad run id or body", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await start(post("/api/sweeps", { runId: RUN }))).status).toBe(401);
    expect((await start(post("/api/sweeps", { runId: "nope" }))).status).toBe(400);
    expect((await advance(post("/api/sweeps/nope/advance", {}), params("nope"))).status).toBe(400);
    const badBatch = { batchId: RUN, proposalIds: [], totalCents: 0 };
    expect((await approveCleanRoute(post(`/api/sweeps/${RUN}/approve-clean`, badBatch), params(RUN))).status).toBe(400);
    expect(mocks.approveClean).not.toHaveBeenCalled();
  });

  it("answer 409 changed with what is clean now when the batch moved", async () => {
    mocks.approveClean.mockResolvedValueOnce({ ok: false, category: "changed", clean: [RUN], totalCents: 1100 });
    const body = { batchId: RUN, proposalIds: [RUN], totalCents: 34000 };
    const res = await approveCleanRoute(post(`/api/sweeps/${RUN}/approve-clean`, body), params(RUN));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "changed", retryable: false, clean: [RUN], totalCents: 1100 });
  });

  it("read a run, or 404 when it is not this carrier's", async () => {
    mocks.readSweepPage.mockResolvedValueOnce(null);
    const res = await readRun(new Request(`https://app.example/api/sweeps/${RUN}`), params(RUN));
    expect(res.status).toBe(404);
    expect(mocks.readSweepPage).toHaveBeenCalledWith(SESSION, RUN);
  });
});

describe("GET /api/sweeps/[id]/trace/[turnId]", () => {
  const TURN = "0A0A0A0A-0A0A-4A0A-8A0A-0A0A0A0A0A0A";
  const call = (id: string, turnId: string) =>
    readTrace(new Request(`https://app.example/api/sweeps/${id}/trace/${turnId}`), {
      params: Promise.resolve({ id, turnId }),
    });

  it("answers 409 disabled before reading a session while the sweep is off", async () => {
    flags.sweepEnabled = false;
    const res = await call(RUN, TURN);
    expect(res.status).toBe(409);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readSweepTurnTrace).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and 400 for an id that is not one", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call(RUN, TURN)).status).toBe(401);
    expect((await call(RUN, "not-a-turn")).status).toBe(400);
    expect((await call("not-a-run", TURN)).status).toBe(400);
    expect(mocks.readSweepTurnTrace).not.toHaveBeenCalled();
  });

  it("reads the turn by the run, or 404 when the run does not name it", async () => {
    mocks.readSweepTurnTrace.mockResolvedValueOnce(null);
    const missing = await call(RUN, TURN);
    expect(missing.status).toBe(404);
    expect(mocks.readSweepTurnTrace).toHaveBeenCalledWith(SESSION, RUN, TURN.toLowerCase());

    mocks.readSweepTurnTrace.mockResolvedValueOnce({ turnId: TURN.toLowerCase(), steps: [] });
    const ok = await call(RUN, TURN);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ trace: { turnId: TURN.toLowerCase(), steps: [] } });
  });

  it("answers 503 with no error text when the read fails", async () => {
    mocks.readSweepTurnTrace.mockRejectedValueOnce(new Error("row 42 secret"));
    const res = await call(RUN, TURN);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
