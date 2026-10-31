import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";

// The asks route's own checks: the cross-site refusal, both switches, the session, the since
// value, the caller's own session handed to the store (its tenant transaction and row-level
// security scope the rows; src/lib/asks/asks.db.test.ts proves that against a real database), and
// the store's errors as categories.

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), readAgentAsks: vi.fn() }));

vi.mock("@/lib/agent/gateway/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/agent/gateway/store", () => ({ readAgentAsks: mocks.readAgentAsks }));

import { GET } from "./route";

const SESSION = { sub: "sub-1", tenantId: "33333333-3333-4333-8333-333333333333", email: "ops@example.test" };
const OTHER = { sub: "sub-2", tenantId: "55555555-5555-4555-8555-555555555555", email: "ops@other.test" };
const READ = {
  asks: [{ id: "a1", kind: "ask", text: "Should I send Dana Reyes an advance of $1,400.00?" }],
  openCount: 1,
  now: "2026-11-02T16:00:00.000Z",
};

function get(query = "", headers: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/agent/asks${query}`, { headers }));
}

const saved = structuredClone(flags);

beforeEach(() => {
  flags.agentEnabled = true;
  flags.agentAsks.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.readAgentAsks.mockResolvedValue(READ);
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/agent/asks", () => {
  it("returns the caller's carrier's asks, never cached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(READ);
    expect(mocks.readAgentAsks).toHaveBeenCalledWith(SESSION, { sinceIso: null });
  });

  it("reads under whoever is signed in, never a tenant from the request", async () => {
    mocks.getSession.mockResolvedValue(OTHER);
    await get(`?since=2026-11-02T15:00:00Z&tenantId=${SESSION.tenantId}`);
    expect(mocks.readAgentAsks).toHaveBeenCalledWith(OTHER, { sinceIso: "2026-11-02T15:00:00.000Z" });
  });

  it("refuses a since that does not read", async () => {
    for (const since of ["yesterday", "2026-11-02", "2026-13-02T15:00:00Z", "2026-11-02T15:00:00+01:00"]) {
      const res = await get(`?since=${encodeURIComponent(since)}`);
      expect(res.status, since).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(mocks.readAgentAsks).not.toHaveBeenCalled();
  });

  it("answers agent_off or asks_off before the session", async () => {
    flags.agentEnabled = false;
    expect(await (await get()).json()).toEqual({ error: "agent_off" });
    flags.agentEnabled = true;
    flags.agentAsks.enabled = false;
    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "asks_off" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.readAgentAsks).not.toHaveBeenCalled();
  });

  it("refuses a cross-site read and a caller with no session", async () => {
    expect((await get("", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    mocks.getSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.readAgentAsks).not.toHaveBeenCalled();
  });

  it("answers a membership refusal and any other failure as categories only", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const forbidden = Object.assign(new Error("no membership for sub-1"), { name: "ForbiddenError" });
    mocks.readAgentAsks.mockRejectedValueOnce(forbidden);
    const a = await get();
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: "forbidden" });
    mocks.readAgentAsks.mockRejectedValueOnce(new Error("connection to db-host refused"));
    const b = await get();
    expect(b.status).toBe(503);
    expect(await b.json()).toEqual({ error: "unavailable" });
    expect(quiet.mock.calls.flat().join(" ")).not.toContain("db-host");
  });
});
