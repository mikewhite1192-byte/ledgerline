import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const WEEK = "2026-10-19";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), writeBrief: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/briefs/write", () => ({ writeBrief: mocks.writeBrief }));

const saved = { brief: flags.profitBriefEnabled, ai: flags.aiEnabled };

function press(body: string, site?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (site) headers["Sec-Fetch-Site"] = site;
  return POST(new Request("https://app.example/api/briefs/profit", { method: "POST", headers, body }));
}

beforeEach(() => {
  flags.profitBriefEnabled = true;
  flags.aiEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.writeBrief.mockReset();
});

afterEach(() => {
  flags.profitBriefEnabled = saved.brief;
  flags.aiEnabled = saved.ai;
  vi.restoreAllMocks();
});

describe("POST /api/briefs/profit", () => {
  it("refuses a cross-site post, no session, either switch off, and a body that is not exactly a week", async () => {
    const body = JSON.stringify({ periodStart: WEEK });
    expect((await press(body, "cross-site")).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.profitBriefEnabled = false;
    const off = await press(body);
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "brief_off" });
    flags.profitBriefEnabled = true;
    flags.aiEnabled = false;
    expect(await (await press(body)).json()).toEqual({ error: "ai_off" });
    flags.aiEnabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await press(body)).status).toBe(401);
    for (const bad of ["{", JSON.stringify({ periodStart: "Oct 19" }), JSON.stringify({ periodStart: WEEK, model: "wonder" }), "[]"]) {
      expect((await press(bad)).status, bad).toBe(400);
    }
    expect(mocks.writeBrief).not.toHaveBeenCalled();
  });

  it("tells a caller with no session nothing about the switches", async () => {
    const body = JSON.stringify({ periodStart: WEEK });
    for (const [brief, ai] of [
      [false, true],
      [true, false],
      [true, true],
    ]) {
      flags.profitBriefEnabled = brief;
      flags.aiEnabled = ai;
      mocks.getSession.mockResolvedValueOnce(null);
      const response = await press(body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
    expect(mocks.writeBrief).not.toHaveBeenCalled();
  });

  it("maps each outcome to its status and says categories only", async () => {
    const cases: [unknown, number, unknown][] = [
      [{ ok: true, briefId: "b1", status: "drafted", category: null }, 200, { briefId: "b1", status: "drafted" }],
      [
        { ok: true, briefId: "b2", status: "refused", category: "untagged" },
        200,
        { briefId: "b2", status: "refused", category: "untagged" },
      ],
      [{ ok: false, category: "not_found" }, 404, { error: "not_found" }],
      [{ ok: false, category: "exists" }, 409, { error: "exists" }],
      [{ ok: false, category: "open_period" }, 409, { error: "open_period" }],
    ];
    for (const [outcome, status, body] of cases) {
      mocks.writeBrief.mockResolvedValueOnce(outcome);
      const response = await press(JSON.stringify({ periodStart: WEEK }));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(body);
    }
    expect(mocks.writeBrief).toHaveBeenCalledWith(SESSION, { kind: "profit_week", periodStart: WEEK });
  });

  it("answers a non-member with forbidden and anything else with a category, never the error text", async () => {
    mocks.writeBrief.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ForbiddenError" }));
    expect((await press(JSON.stringify({ periodStart: WEEK }))).status).toBe(403);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.writeBrief.mockRejectedValueOnce(new Error("connection to db.secret.example refused"));
    const response = await press(JSON.stringify({ periodStart: WEEK }));
    expect(response.status).toBe(503);
    // It may have failed after the model was asked: the outcome is unknown, never "nothing was sent".
    expect(await response.json()).toEqual({ error: "unknown" });
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("secret");
  });
});
