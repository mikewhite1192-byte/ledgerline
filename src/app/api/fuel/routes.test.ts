import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as dismiss } from "./findings/[id]/dismiss/route";
import { POST as propose } from "./findings/[id]/propose/route";
import { POST as run } from "./runs/route";

// The fuel routes' gates, with the service a stand-in: the cross-site check and the switch answer
// before any session is read, a bad id or reason never reaches the service, and an answer carries
// categories only. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const FINDING = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const CARD = "7c2d0e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  runFuelCheck: vi.fn(),
  proposeFuelCorrection: vi.fn(),
  dismissFuelFinding: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/fuel/run", () => ({ runFuelCheck: mocks.runFuelCheck }));
vi.mock("@/lib/fuel/propose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fuel/propose")>()),
  proposeFuelCorrection: mocks.proposeFuelCorrection,
  dismissFuelFinding: mocks.dismissFuelFinding,
}));

const saved = { ...flags };

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  flags.fuelAnomalyEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.runFuelCheck.mockResolvedValue({ ok: true, runId: FINDING, checked: 464, needYou: 4 });
  mocks.proposeFuelCorrection.mockResolvedValue({ ok: true, proposalId: CARD, existing: false });
  mocks.dismissFuelFinding.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags, saved);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/fuel/runs", () => {
  it("runs the check for the signed-in carrier and answers the counts only", async () => {
    const res = await run(post("/api/fuel/runs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ checked: 464, needYou: 4 });
    expect(mocks.runFuelCheck).toHaveBeenCalledWith(SESSION);
  });

  it("refuses a cross-site post and a switched-off check before reading the session", async () => {
    expect((await run(post("/api/fuel/runs", undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    flags.fuelAnomalyEnabled = false;
    const off = await run(post("/api/fuel/runs"));
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runFuelCheck).not.toHaveBeenCalled();
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await run(post("/api/fuel/runs"))).status).toBe(401);
    expect(mocks.runFuelCheck).not.toHaveBeenCalled();
  });

  it("maps busy, failed and unknown to their categories", async () => {
    mocks.runFuelCheck.mockResolvedValueOnce({ ok: false, category: "busy" });
    const busy = await run(post("/api/fuel/runs"));
    expect([busy.status, await busy.json()]).toEqual([409, { error: "busy", retryable: true }]);
    mocks.runFuelCheck.mockResolvedValueOnce({ ok: false, category: "failed" });
    const failed = await run(post("/api/fuel/runs"));
    expect([failed.status, await failed.json()]).toEqual([503, { error: "failed", retryable: true }]);
    mocks.runFuelCheck.mockResolvedValueOnce({ ok: false, category: "unknown" });
    const unknown = await run(post("/api/fuel/runs"));
    expect([unknown.status, await unknown.json()]).toEqual([503, { error: "unknown", retryable: false }]);
  });

  it("never echoes a thrown error's text", async () => {
    mocks.runFuelCheck.mockRejectedValueOnce(new Error("row 42 secret text"));
    const res = await run(post("/api/fuel/runs"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    const forbidden = new Error("no membership");
    forbidden.name = "ForbiddenError";
    mocks.runFuelCheck.mockRejectedValueOnce(forbidden);
    expect((await run(post("/api/fuel/runs"))).status).toBe(403);
  });
});

describe("POST /api/fuel/findings/[id]/propose", () => {
  const call = (id: string, headers: Record<string, string> = {}) =>
    propose(post(`/api/fuel/findings/${id}/propose`, undefined, headers), params(id));

  it("drafts the card and answers its id", async () => {
    const res = await call(FINDING);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposalId: CARD, existing: false });
    expect(mocks.proposeFuelCorrection).toHaveBeenCalledWith(SESSION, FINDING);
  });

  it("refuses cross-site, off, signed out and a bad id before the service", async () => {
    expect((await call(FINDING, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await call("not-a-uuid")).status).toBe(400);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call(FINDING)).status).toBe(401);
    flags.fuelAnomalyEnabled = false;
    expect((await call(FINDING)).status).toBe(409);
    expect(mocks.proposeFuelCorrection).not.toHaveBeenCalled();
  });

  it.each(["live_exists", "changed", "no_suggestion", "no_open_period", "already_decided"])(
    "answers %s as a 409 with the category",
    async (category) => {
      mocks.proposeFuelCorrection.mockResolvedValueOnce({ ok: false, category });
      const res = await call(FINDING);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: category, retryable: false });
    },
  );
});

describe("POST /api/fuel/findings/[id]/dismiss", () => {
  const call = (id: string, body: unknown) => dismiss(post(`/api/fuel/findings/${id}/dismiss`, body), params(id));

  it("records a reason from the fixed list", async () => {
    const res = await call(FINDING, { category: "pump_error" });
    expect(res.status).toBe(200);
    expect(mocks.dismissFuelFinding).toHaveBeenCalledWith(SESSION, FINDING, "pump_error");
  });

  it("refuses a reason outside the list, no body and a bad id", async () => {
    expect((await call(FINDING, { category: "because the driver said so" })).status).toBe(400);
    expect((await call(FINDING, { category: "__proto__" })).status).toBe(400);
    expect((await call(FINDING, [])).status).toBe(400);
    expect((await call(FINDING, undefined)).status).toBe(400);
    expect((await call("x", { category: "other" })).status).toBe(400);
    expect(mocks.dismissFuelFinding).not.toHaveBeenCalled();
  });

  it("answers changed when the finding moved on", async () => {
    mocks.dismissFuelFinding.mockResolvedValueOnce({ ok: false, category: "changed" });
    expect((await call(FINDING, { category: "other" })).status).toBe(409);
  });
});
