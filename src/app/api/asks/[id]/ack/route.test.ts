import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";

// The acknowledge route's own checks, in order: a cross-site post, the switch, the login, the
// staff gate (a demo visitor refused), the id and an empty body, each before anything is written;
// the caller's own session goes to the write (its tenant transaction and row-level security scope
// the line); no open told line is 404; errors are categories only.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), ackForSession: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/asks/session", () => ({ ackForSession: mocks.ackForSession }));

import { POST } from "./route";

function ack(opts: { id?: string; site?: string; body?: string } = {}) {
  const id = opts.id ?? ID;
  const headers: Record<string, string> = {};
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  return POST(new Request(`https://app.example/api/asks/${id}/ack`, { method: "POST", headers, body: opts.body }), {
    params: Promise.resolve({ id }),
  });
}

const saved = structuredClone(flags.agentAsks);

beforeEach(() => {
  flags.agentAsks.enabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.staffGate.mockReset().mockResolvedValue(null);
  mocks.ackForSession.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  Object.assign(flags.agentAsks, structuredClone(saved));
  vi.restoreAllMocks();
});

describe("POST /api/asks/:id/ack", () => {
  it("marks the caller's told line seen, with no body or an empty object", async () => {
    const res = await ack();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.ackForSession).toHaveBeenCalledWith(SESSION, ID);
    expect((await ack({ body: "{}" })).status).toBe(200);
  });

  it("answers not_found when no open told line has that id in the caller's carrier", async () => {
    mocks.ackForSession.mockResolvedValue(false);
    const res = await ack();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses a cross-site post, the switch off, no session, a demo visitor, a bad id and a body before writing", async () => {
    expect((await ack({ site: "cross-site" })).status).toBe(403);
    flags.agentAsks.enabled = false;
    expect(await (await ack()).json()).toEqual({ error: "asks_off" });
    flags.agentAsks.enabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await ack()).status).toBe(401);
    mocks.staffGate.mockResolvedValueOnce(Response.json({ error: "judge", retryable: false }, { status: 403 }));
    const judge = await ack();
    expect(judge.status).toBe(403);
    expect(await judge.json()).toEqual({ error: "judge", retryable: false });
    mocks.staffGate.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    expect((await ack()).status).toBe(403);
    expect((await ack({ id: "not-a-uuid" })).status).toBe(400);
    for (const body of ['{"status":"done"}', "[]", "null", "not json", `{"a":"${"x".repeat(40)}"}`]) {
      const res = await ack({ body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(mocks.ackForSession).not.toHaveBeenCalled();
  });

  it("answers a membership refusal and any other failure as categories only", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.ackForSession.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    expect((await ack()).status).toBe(403);
    mocks.ackForSession.mockRejectedValueOnce(new Error("connection to db-host refused"));
    const res = await ack();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(quiet.mock.calls.flat().join(" ")).not.toContain("db-host");
  });
});
