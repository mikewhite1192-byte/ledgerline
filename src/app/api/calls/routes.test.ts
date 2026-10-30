import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { ForbiddenError } from "@/lib/tenant/context";
import { POST as end } from "./[id]/end/route";
import { POST as handOff } from "./[id]/segments/[seq]/hand-off/route";
import { POST as segment } from "./[id]/segments/route";

// The phone line routes' own checks, in order: a cross-site post is refused before the session is
// read, then the phone line switch, the login, the call id, the body cap and the fields, each
// before the pipeline runs. Replies carry a category only, never an error's text, and are never
// cached.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const CALL = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa";
const DRIVER = "bbbbbbbb-3333-4bbb-8bbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  receiveSegment: vi.fn(),
  finishHandOff: vi.fn(),
  endCall: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/calls/pipeline", () => ({
  receiveSegment: mocks.receiveSegment,
  finishHandOff: mocks.finishHandOff,
  endCall: mocks.endCall,
}));

const saved = structuredClone(flags);
let logged: unknown[][] = [];

const DONE = { ok: true, callId: CALL, seq: 0, status: "done", turns: [] };

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.phoneLineEnabled = true;
  logged = [];
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.receiveSegment.mockReset().mockResolvedValue(DONE);
  mocks.finishHandOff.mockReset().mockResolvedValue(DONE);
  mocks.endCall.mockReset().mockResolvedValue({ ok: true, callId: CALL, status: "ended" });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.restoreAllMocks();
});

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const wav = (bytes = 4) => new Blob([new Uint8Array(bytes).fill(7)], { type: "audio/wav" });
const FIELDS = () => ({ seq: "0", offsetMs: "0", driverId: DRIVER, wav: wav() });

async function postSegment(fields: Record<string, string | Blob>, headers: Record<string, string> = {}, id = CALL) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return segment(
    new Request(`https://app.example/api/calls/${id}/segments`, {
      method: "POST",
      headers: { "content-type": encoded.headers.get("content-type") ?? "", ...headers },
      body,
    }),
    params({ id }),
  );
}

const plain = (site = "same-origin") =>
  new Request("https://app.example/api/calls", { method: "POST", headers: { "Sec-Fetch-Site": site } });

const postHandOff = (id = CALL, seq = "0", site = "same-origin") => handOff(plain(site), params({ id, seq }));
const postEnd = (id = CALL, site = "same-origin") => end(plain(site), params({ id }));

describe("POST /api/calls/[id]/segments", () => {
  it("passes a well-formed segment on and answers with what it stored, never cached", async () => {
    const response = await postSegment({ seq: "3", offsetMs: "90000", driverId: DRIVER, wav: wav(6) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(DONE);
    const [session, input] = mocks.receiveSegment.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(input).toMatchObject({ callId: CALL, seq: 3, offsetMs: 90_000, driverId: DRIVER });
    expect(Array.from(input.wav as Uint8Array)).toEqual([7, 7, 7, 7, 7, 7]);
  });

  it("refuses a cross-site post before reading the session", async () => {
    const response = await postSegment(FIELDS(), { "Sec-Fetch-Site": "cross-site" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses when switched off, then without a login, then a call id that is not one", async () => {
    flags.phoneLineEnabled = false;
    const off = await postSegment(FIELDS());
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.phoneLineEnabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await postSegment(FIELDS())).status).toBe(401);
    const badId = await postSegment(FIELDS(), {}, "call-1");
    expect(badId.status).toBe(400);
    expect(mocks.receiveSegment).not.toHaveBeenCalled();
  });

  it("refuses a segment past the cap by its declared length, before the body is read", async () => {
    const response = await postSegment(FIELDS(), { "content-length": "99999999" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large", retryable: false });
    expect(mocks.receiveSegment).not.toHaveBeenCalled();
  });

  it("refuses a recording past its own cap before copying its bytes", async () => {
    flags.phoneLineLimits = { ...flags.phoneLineLimits, maxSegmentBytes: 3 };
    const response = await postSegment(FIELDS());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large", retryable: false });
    expect(mocks.receiveSegment).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing seq", { offsetMs: "0", driverId: DRIVER, wav: wav() }],
    ["a negative seq", { ...FIELDS(), seq: "-1" }],
    ["a seq with a leading zero", { ...FIELDS(), seq: "01" }],
    ["a fractional offset", { ...FIELDS(), offsetMs: "1.5" }],
    ["a missing driver", { seq: "0", offsetMs: "0", wav: wav() }],
    ["a recording sent as text", { ...FIELDS(), wav: "not audio" }],
  ])("refuses %s", async (_label, fields) => {
    const response = await postSegment(fields as Record<string, string | Blob>);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request", retryable: false });
    expect(mocks.receiveSegment).not.toHaveBeenCalled();
  });

  it("answers a refusal with its category and its retry flag only", async () => {
    mocks.receiveSegment.mockResolvedValueOnce({ ok: false, category: "rate_limited", retryable: true });
    const limited = await postSegment(FIELDS());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", retryable: true });
    mocks.receiveSegment.mockResolvedValueOnce({ ok: false, category: "not_open", retryable: false });
    expect((await postSegment(FIELDS())).status).toBe(409);
  });

  it("answers a thrown error as unavailable, without its text in the reply or the log", async () => {
    mocks.receiveSegment.mockRejectedValueOnce(new Error("upstream said the driver wants diesel money"));
    const response = await postSegment(FIELDS());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unavailable", retryable: true });
    expect(logged.map((l) => l.map(String).join(" ")).join("\n")).not.toContain("diesel");
    mocks.receiveSegment.mockRejectedValueOnce(new ForbiddenError());
    expect((await postSegment(FIELDS())).status).toBe(403);
  });
});

describe("POST /api/calls/[id]/segments/[seq]/hand-off", () => {
  it("finishes the hand-off for a well-formed place", async () => {
    const response = await postHandOff(CALL, "12");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.finishHandOff).toHaveBeenCalledWith(SESSION, CALL, 12);
  });

  it("refuses cross-site, switched off, without a login, and a bad id or place, before the pipeline", async () => {
    expect((await postHandOff(CALL, "0", "cross-site")).status).toBe(403);
    flags.phoneLineEnabled = false;
    expect(await (await postHandOff()).json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.phoneLineEnabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await postHandOff()).status).toBe(401);
    expect((await postHandOff("call-1")).status).toBe(400);
    expect((await postHandOff(CALL, "x")).status).toBe(400);
    expect((await postHandOff(CALL, "-1")).status).toBe(400);
    expect(mocks.finishHandOff).not.toHaveBeenCalled();
  });

  it("answers a thrown error as unavailable", async () => {
    mocks.finishHandOff.mockRejectedValueOnce(new Error("upstream text"));
    const response = await postHandOff();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable", retryable: true });
  });
});

describe("POST /api/calls/[id]/end", () => {
  it("ends the call", async () => {
    const response = await postEnd();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, callId: CALL, status: "ended" });
    expect(mocks.endCall).toHaveBeenCalledWith(SESSION, CALL);
  });

  it("refuses cross-site, switched off, without a login, and a bad id, before the pipeline", async () => {
    expect((await postEnd(CALL, "cross-site")).status).toBe(403);
    flags.phoneLineEnabled = false;
    expect(await (await postEnd()).json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.phoneLineEnabled = true;
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await postEnd()).status).toBe(401);
    expect((await postEnd("call-1")).status).toBe(400);
    expect(mocks.endCall).not.toHaveBeenCalled();
  });

  it("answers not_found and a thrown error by category only", async () => {
    mocks.endCall.mockResolvedValueOnce({ ok: false, category: "not_found", retryable: false });
    expect((await postEnd()).status).toBe(404);
    mocks.endCall.mockRejectedValueOnce(new Error("upstream text"));
    const response = await postEnd();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable", retryable: true });
  });
});
