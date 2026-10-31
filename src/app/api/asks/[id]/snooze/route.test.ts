import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";

// The snooze route's own checks, in order: a cross-site post, the switch, the login, the staff
// gate and the id, each before anything is written; the caller's own session goes to the write
// (its tenant transaction and row-level security scope the ask); no live ask is 404; errors are
// categories only.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), snoozeForSession: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/asks/session", () => ({ snoozeForSession: mocks.snoozeForSession }));

import { POST } from "./route";

function snooze(opts: { id?: string; site?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = {};
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  return POST(new Request(`https://app.example/api/asks/${id}/snooze`, { method: "POST", headers }), {
    params: Promise.resolve({ id }),
  });
}

const saved = structuredClone(flags.agentAsks);

beforeEach(() => {
  flags.agentAsks.enabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.staffGate.mockReset().mockResolvedValue(null);
  mocks.snoozeForSession.mockReset().mockResolvedValue({ snoozedUntil: "2026-11-02T20:00:00.000Z" });
});

afterEach(() => {
  Object.assign(flags.agentAsks, structuredClone(saved));
  vi.restoreAllMocks();
});

describe("POST /api/asks/:id/snooze", () => {
  it("snoozes the caller's ask and says until when", async () => {
    const res = await snooze();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, snoozedUntil: "2026-11-02T20:00:00.000Z" });
    expect(mocks.snoozeForSession).toHaveBeenCalledWith(SESSION, ID);
  });

  it("answers not_found when no live ask has that id in the caller's carrier", async () => {
    mocks.snoozeForSession.mockResolvedValue(null);
    const res = await snooze();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses a cross-site post, the switch off, no session, a demo visitor and a bad id before writing", async () => {
    expect((await snooze({ site: "cross-site" })).status).toBe(403);
    flags.agentAsks.enabled = false;
    expect(await (await snooze()).json()).toEqual({ error: "asks_off" });
    flags.agentAsks.enabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await snooze()).status).toBe(401);
    mocks.staffGate.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    expect((await snooze()).status).toBe(403);
    expect((await snooze({ id: "not-a-uuid" })).status).toBe(400);
    expect(mocks.snoozeForSession).not.toHaveBeenCalled();
  });

  it("answers a membership refusal and any other failure as categories only", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.snoozeForSession.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    expect((await snooze()).status).toBe(403);
    mocks.snoozeForSession.mockRejectedValueOnce(new Error("connection to db-host refused"));
    const res = await snooze();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(quiet.mock.calls.flat().join(" ")).not.toContain("db-host");
  });
});
