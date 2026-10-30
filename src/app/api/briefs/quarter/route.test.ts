import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { maxDuration, POST } from "./route";

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), writeQuarterReview: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/briefs/write-quarter", () => ({ writeQuarterReview: mocks.writeQuarterReview }));

const saved = { review: flags.quarterReviewEnabled, ai: flags.aiEnabled };

function press(body: string, site?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (site) headers["Sec-Fetch-Site"] = site;
  return POST(new Request("https://app.example/api/briefs/quarter", { method: "POST", headers, body }));
}

beforeEach(() => {
  flags.quarterReviewEnabled = true;
  flags.aiEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.writeQuarterReview.mockReset();
});

afterEach(() => {
  flags.quarterReviewEnabled = saved.review;
  flags.aiEnabled = saved.ai;
  vi.restoreAllMocks();
});

describe("POST /api/briefs/quarter", () => {
  it("refuses a cross-site post, no session, either switch off, and any body but an empty object", async () => {
    expect((await press("{}", "cross-site")).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.quarterReviewEnabled = false;
    const off = await press("{}");
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "review_off" });
    flags.quarterReviewEnabled = true;
    flags.aiEnabled = false;
    expect(await (await press("{}")).json()).toEqual({ error: "ai_off" });
    flags.aiEnabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await press("{}")).status).toBe(401);
    for (const bad of ["{", JSON.stringify({ quarter: "2026-10-01" }), JSON.stringify({ model: "spark" }), "[]", "null"]) {
      expect((await press(bad)).status, bad).toBe(400);
    }
    expect(mocks.writeQuarterReview).not.toHaveBeenCalled();
  });

  it("tells a caller with no session nothing about the switches", async () => {
    for (const [review, ai] of [
      [false, true],
      [true, false],
      [true, true],
    ]) {
      flags.quarterReviewEnabled = review;
      flags.aiEnabled = ai;
      mocks.getSession.mockResolvedValueOnce(null);
      const response = await press("{}");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
    expect(mocks.writeQuarterReview).not.toHaveBeenCalled();
  });

  it("maps each outcome to its status and says categories only", async () => {
    const cases: [unknown, number, unknown][] = [
      [{ ok: true, briefId: "q1", status: "drafted", category: null }, 200, { briefId: "q1", status: "drafted" }],
      [
        { ok: true, briefId: "q2", status: "refused", category: "timeout" },
        200,
        { briefId: "q2", status: "refused", category: "timeout" },
      ],
      [
        { ok: true, briefId: "q3", status: "over_cap", category: "cap" },
        200,
        { briefId: "q3", status: "over_cap", category: "cap" },
      ],
      [{ ok: false, category: "not_found" }, 404, { error: "not_found" }],
      [{ ok: false, category: "exists" }, 409, { error: "exists" }],
      [{ ok: false, category: "in_progress" }, 409, { error: "in_progress" }],
      [{ ok: false, category: "no_activity" }, 409, { error: "no_activity" }],
    ];
    for (const [outcome, status, body] of cases) {
      mocks.writeQuarterReview.mockResolvedValueOnce(outcome);
      const response = await press("{}");
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(body);
    }
    expect(mocks.writeQuarterReview).toHaveBeenCalledWith(SESSION);
  });

  it("answers a non-member with forbidden and anything else with a category, never the error text", async () => {
    mocks.writeQuarterReview.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ForbiddenError" }));
    expect((await press("{}")).status).toBe(403);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.writeQuarterReview.mockRejectedValueOnce(new Error("connection to db.secret.example refused"));
    const response = await press("{}");
    expect(response.status).toBe(503);
    // It may have failed after the model was asked: the outcome is unknown, never "nothing was sent".
    expect(await response.json()).toEqual({ error: "unknown" });
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("secret");
  });

  it("gives up on the model well before the route is stopped, leaving room for the reads and the two transactions", async () => {
    const { QUARTER_TIMEOUT_MS } = await vi.importActual<typeof import("@/lib/briefs/write-quarter")>(
      "@/lib/briefs/write-quarter",
    );
    expect(QUARTER_TIMEOUT_MS).toBe(20_000);
    expect(maxDuration * 1_000 - QUARTER_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
