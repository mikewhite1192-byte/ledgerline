import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";

// The recent route's own checks: the cross-site refusal, both switches, the session, and the
// store's errors as categories. Tenant isolation against a real database is in
// src/lib/agent/gateway/focus.db.test.ts.

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), readAgentThread: vi.fn() }));

vi.mock("@/lib/agent/gateway/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/agent/gateway/store", () => ({ readAgentThread: mocks.readAgentThread }));

import { GET } from "./route";

const SESSION = { sub: "sub-1", tenantId: "33333333-3333-4333-8333-333333333333", email: "ops@example.test" };
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

function get(headers: Record<string, string> = {}) {
  return GET(new Request("http://localhost/api/agent/recent", { headers }));
}

const saved = structuredClone(flags);

beforeEach(() => {
  flags.agentEnabled = true;
  flags.agentFocusEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.readAgentThread.mockResolvedValue({ turns: [], asks: [], thread: [] });
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/agent/recent", () => {
  it("returns the newest conversation's id and turns, never cached", async () => {
    const turns = [
      { id: "t1", conversationId: CONVERSATION, seq: 1 },
      { id: "t2", conversationId: CONVERSATION, seq: 2 },
    ];
    const asks = [{ id: "a1", kind: "ask", text: "Should I send Dana Reyes an advance of $1,400.00?" }];
    const thread = [
      { type: "turn", id: "t1", at: "2026-11-02T14:00:00.000Z" },
      { type: "ask", id: "a1", at: "2026-11-02T14:05:00.000Z" },
      { type: "turn", id: "t2", at: "2026-11-02T14:10:00.000Z" },
    ];
    mocks.readAgentThread.mockResolvedValue({ turns, asks, thread });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ conversationId: CONVERSATION, turns, asks, thread });
    expect(mocks.readAgentThread).toHaveBeenCalledWith(SESSION);
  });

  it("returns no conversation when the caller has none", async () => {
    const res = await get();
    expect(await res.json()).toEqual({ conversationId: null, turns: [], asks: [], thread: [] });
  });

  it("answers agent_off with either switch off, before the session", async () => {
    for (const off of ["agentEnabled", "agentFocusEnabled"] as const) {
      flags.agentEnabled = true;
      flags.agentFocusEnabled = true;
      flags[off] = false;
      const res = await get();
      expect(res.status, off).toBe(409);
      expect(await res.json()).toEqual({ error: "agent_off" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readAgentThread).not.toHaveBeenCalled();
  });

  it("refuses a cross-site read and a caller with no session", async () => {
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    mocks.getSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.readAgentThread).not.toHaveBeenCalled();
  });

  it("answers a membership refusal and any other failure as categories only", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const forbidden = Object.assign(new Error("no membership for sub-1"), { name: "ForbiddenError" });
    mocks.readAgentThread.mockRejectedValueOnce(forbidden);
    const a = await get();
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: "forbidden" });
    mocks.readAgentThread.mockRejectedValueOnce(new Error("connection to db-host refused"));
    const b = await get();
    expect(b.status).toBe(503);
    expect(await b.json()).toEqual({ error: "unavailable" });
    expect(quiet.mock.calls.flat().join(" ")).not.toContain("db-host");
  });
});
