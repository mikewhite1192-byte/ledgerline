import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const LOAD = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), startPortalRun: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/portal/start", () => ({ startPortalRun: mocks.startPortalRun }));

function start(body: string, site?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (site) headers["Sec-Fetch-Site"] = site;
  return POST(new Request("https://app.example/api/portal-runs", { method: "POST", headers, body }));
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.startPortalRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/portal-runs", () => {
  it("refuses a cross-site post, no session, and a body that is not exactly a load id", async () => {
    expect((await start(JSON.stringify({ loadId: LOAD }), "cross-site")).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await start(JSON.stringify({ loadId: LOAD }))).status).toBe(401);
    for (const body of ["{", JSON.stringify({ loadId: "nope" }), JSON.stringify({ loadId: LOAD, model: "spark" })]) {
      expect((await start(body)).status, body).toBe(400);
    }
    expect(mocks.startPortalRun).not.toHaveBeenCalled();
  });

  it("maps each outcome to its status, and a person's start always refreshes", async () => {
    const cases: [unknown, number, unknown][] = [
      [{ kind: "disabled" }, 409, { started: false, reason: "disabled" }],
      [{ kind: "no_portal_load" }, 404, { error: "no_portal_load" }],
      [{ kind: "live", runId: "r1", status: "running" }, 409, { error: "live_run", runId: "r1", status: "running" }],
      [{ kind: "queued", runId: "r2" }, 202, { status: "queued", runId: "r2" }],
    ];
    for (const [outcome, status, body] of cases) {
      mocks.startPortalRun.mockResolvedValueOnce(outcome);
      const response = await start(JSON.stringify({ loadId: LOAD }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    expect(mocks.startPortalRun).toHaveBeenCalledWith(SESSION, { loadId: LOAD, refresh: true, turnId: null });
  });

  it("answers a non-member with forbidden", async () => {
    mocks.startPortalRun.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ForbiddenError" }));
    const response = await start(JSON.stringify({ loadId: LOAD }));
    expect(response.status).toBe(403);
  });
});
