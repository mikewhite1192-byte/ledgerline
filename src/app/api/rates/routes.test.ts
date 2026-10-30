import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as pinOne } from "./[id]/pin/route";
import { POST as lookup } from "./lookup/route";
import { POST as pinTyped } from "./pin/route";

// The rates routes' gates, with the services stand-ins: the cross-site check and the switch answer
// before any session is read, a bad body or id never reaches a service, and every answer carries a
// category, never a page's text or an error's. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const RATE = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  staffGate: vi.fn(),
  lookupRate: vi.fn(),
  pinSuggestion: vi.fn(),
  pinTyped: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here a caller is staff
// unless a test says it is a demo visitor (the judge role).
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/rates/lookup", () => ({ lookupRate: mocks.lookupRate }));
vi.mock("@/lib/rates/pin", () => ({ pinSuggestion: mocks.pinSuggestion, pinTyped: mocks.pinTyped }));

const saved = { ...flags };

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  flags.groundedRatesEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.staffGate.mockResolvedValue(null);
  mocks.lookupRate.mockResolvedValue({ ok: true, status: "suggested", id: RATE });
  mocks.pinSuggestion.mockResolvedValue({ ok: true, id: RATE });
  mocks.pinTyped.mockResolvedValue({ ok: true, id: RATE, already: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags, saved);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/rates/lookup", () => {
  it("starts a lookup for the signed-in carrier and answers its status and id only", async () => {
    const res = await lookup(post("/api/rates/lookup", { kind: "ifta_rate", state: "IL", extra: "x" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, status: "suggested", id: RATE });
    expect(mocks.lookupRate).toHaveBeenCalledWith(SESSION, { kind: "ifta_rate", state: "IL" });
  });

  it("refuses a cross-site post and a switched-off lookup before reading the session", async () => {
    expect((await lookup(post("/api/rates/lookup", { kind: "diesel_index" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    flags.groundedRatesEnabled = false;
    const off = await lookup(post("/api/rates/lookup", { kind: "diesel_index" }));
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.lookupRate).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and 400 for a body that is not a JSON object", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await lookup(post("/api/rates/lookup", { kind: "diesel_index" }))).status).toBe(401);
    for (const body of ["not json", "[1]", "", JSON.stringify({ kind: "x".repeat(5000) })]) {
      expect((await lookup(post("/api/rates/lookup", body))).status, body.slice(0, 20)).toBe(400);
    }
    expect(mocks.lookupRate).not.toHaveBeenCalled();
  });

  it("answers each refusal and failure by its category and status", async () => {
    const cases: [object, number, string, boolean][] = [
      [{ ok: false, refused: "off" }, 409, "disabled", false],
      [{ ok: false, refused: "forbidden" }, 403, "forbidden", false],
      [{ ok: false, refused: "bad_request" }, 400, "bad_request", false],
      [{ ok: false, refused: "limit" }, 429, "limit", false],
      [{ ok: false, failed: "budget" }, 503, "budget", false],
      [{ ok: false, failed: "no_source" }, 422, "no_source", true],
      [{ ok: false, failed: "failed" }, 503, "failed", true],
    ];
    for (const [out, status, error, retryable] of cases) {
      mocks.lookupRate.mockResolvedValueOnce(out);
      const res = await lookup(post("/api/rates/lookup", { kind: "diesel_index" }));
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error, retryable });
    }
  });

  it("answers a thrown error as failed and logs its name only", async () => {
    mocks.lookupRate.mockRejectedValueOnce(new Error("connection to 10.0.0.1 refused: secret detail"));
    const res = await lookup(post("/api/rates/lookup", { kind: "diesel_index" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "failed", retryable: true });
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("secret detail");
  });
});

describe("POST /api/rates/[id]/pin", () => {
  it("pins the suggestion from the day given", async () => {
    const res = await pinOne(post(`/api/rates/${RATE}/pin`, { effectiveFrom: "2026-10-26" }), params(RATE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: RATE });
    expect(mocks.pinSuggestion).toHaveBeenCalledWith(SESSION, { id: RATE, effectiveFrom: "2026-10-26" });
  });

  it("refuses cross-site, switched off, no session, a bad id or a bad body before the service", async () => {
    expect(
      (await pinOne(post(`/api/rates/${RATE}/pin`, {}, { "sec-fetch-site": "cross-site" }), params(RATE))).status,
    ).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await pinOne(post(`/api/rates/${RATE}/pin`, {}), params(RATE))).status).toBe(401);
    expect((await pinOne(post("/api/rates/x/pin", { effectiveFrom: "2026-10-26" }), params("not-a-uuid"))).status).toBe(400);
    expect((await pinOne(post(`/api/rates/${RATE}/pin`, "[]"), params(RATE))).status).toBe(400);
    flags.groundedRatesEnabled = false;
    expect((await pinOne(post(`/api/rates/${RATE}/pin`, {}), params(RATE))).status).toBe(409);
    expect(mocks.pinSuggestion).not.toHaveBeenCalled();
  });

  it("answers a staff member's pin, a changed rate and a missing one by category", async () => {
    const cases: [object, number, string][] = [
      [{ ok: false, refused: "forbidden" }, 403, "forbidden"],
      [{ ok: false, refused: "changed" }, 409, "changed"],
      [{ ok: false, refused: "not_found" }, 404, "not_found"],
      [{ ok: false, refused: "off" }, 409, "disabled"],
      [{ ok: false, failed: "failed" }, 503, "failed"],
    ];
    for (const [out, status, error] of cases) {
      mocks.pinSuggestion.mockResolvedValueOnce(out);
      const res = await pinOne(post(`/api/rates/${RATE}/pin`, { effectiveFrom: "2026-10-26" }), params(RATE));
      expect(res.status, error).toBe(status);
      expect((await res.json()).error).toBe(error);
    }
  });
});

describe("POST /api/rates/pin", () => {
  it("pins a typed rate with its page and day, and says when it was already pinned", async () => {
    const body = { kind: "ifta_rate", state: "IN", rate: "0.61", sourceUrl: "https://rates.example/tax", effectiveFrom: "2026-10-01" };
    mocks.pinTyped.mockResolvedValueOnce({ ok: true, id: RATE, already: true });
    const res = await pinTyped(post("/api/rates/pin", { ...body, valueMcents: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: RATE, already: true });
    expect(mocks.pinTyped).toHaveBeenCalledWith(SESSION, body);
  });

  it("refuses before the service and answers refusals by category", async () => {
    flags.groundedRatesEnabled = false;
    expect((await pinTyped(post("/api/rates/pin", { kind: "diesel_index" }))).status).toBe(409);
    flags.groundedRatesEnabled = true;
    expect((await pinTyped(post("/api/rates/pin", "nope"))).status).toBe(400);
    expect(mocks.pinTyped).not.toHaveBeenCalled();
    mocks.pinTyped.mockResolvedValueOnce({ ok: false, refused: "bad_request" });
    const res = await pinTyped(post("/api/rates/pin", { kind: "diesel_index", rate: "abc" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", retryable: false });
  });
});

// A demo visitor reads the rates page but starts no lookup (it keeps a suggestion and spends the
// carrier's lookups for the day) and pins nothing: each route answers the judge refusal from the
// staff check before it reads the body or reaches a service.
describe("a demo visitor (the judge role) on the rates routes", () => {
  const judge = () =>
    mocks.staffGate.mockResolvedValue(NextResponse.json({ error: "judge", retryable: false }, { status: 403 }));

  const calls: [string, () => Request, (r: Request) => Promise<Response>][] = [
    ["POST /api/rates/lookup", () => post("/api/rates/lookup", { kind: "diesel_index" }), (r) => lookup(r)],
    ["POST /api/rates/[id]/pin", () => post(`/api/rates/${RATE}/pin`, { effectiveFrom: "2026-10-26" }), (r) => pinOne(r, params(RATE))],
    [
      "POST /api/rates/pin",
      () => post("/api/rates/pin", { kind: "diesel_index", rate: "3.657", sourceUrl: "https://rates.example/x", effectiveFrom: "2026-10-26" }),
      (r) => pinTyped(r),
    ],
  ];

  it.each(calls)("%s refuses a judge before any work", async (_key, make, call) => {
    judge();
    const request = make();
    const res = await call(request);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledTimes(1);
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.lookupRate).not.toHaveBeenCalled();
    expect(mocks.pinSuggestion).not.toHaveBeenCalled();
    expect(mocks.pinTyped).not.toHaveBeenCalled();
  });

  it("runs the staff check only after the session, so a signed-out caller still reads 401", async () => {
    judge();
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await lookup(post("/api/rates/lookup", { kind: "diesel_index" }))).status).toBe(401);
    expect(mocks.staffGate).not.toHaveBeenCalled();
  });
});
