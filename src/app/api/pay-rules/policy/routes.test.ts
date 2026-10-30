import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET as RUN, POST as ADVANCE } from "./[turnId]/route";
import { POST } from "./route";
import { POST as SAMPLE } from "./sample/route";

// The policy run routes' own checks, in order, with the session and the run faked: a cross-site
// post is refused before the session is read, then the login, the staff check (a judge is refused
// on every POST, before the body is read; GET only reads and is not gated), the switch, the size
// and the form (or the sample's name), each before anything is stored. A refusal answers its own
// status, a thrown error answers unavailable with only its name logged, and replies carry
// categories only.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const TURN = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  startPolicyRun: vi.fn(),
  readPolicyRun: vi.fn(),
  advancePolicyRun: vi.fn(),
  staffGate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here a caller is staff unless
// a test says it is a judge.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/policy-onboard/run", () => ({
  startPolicyRun: mocks.startPolicyRun,
  readPolicyRun: mocks.readPolicyRun,
  advancePolicyRun: mocks.advancePolicyRun,
}));

async function upload(opts: { site?: string; files?: File[]; extra?: Record<string, string>; length?: string } = {}) {
  const form = new FormData();
  for (const f of opts.files ?? [new File([PDF], "policy.pdf", { type: "application/pdf" })]) form.append("file", f);
  for (const [k, v] of Object.entries(opts.extra ?? {})) form.append(k, v);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const headers: Record<string, string> = {
    "content-type": encoded.headers.get("content-type") ?? "",
    "content-length": opts.length ?? String(body.byteLength),
  };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  return POST(new Request("https://app.example/api/pay-rules/policy", { method: "POST", headers, body }));
}

function sample(body: unknown, site?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (site) headers["Sec-Fetch-Site"] = site;
  return SAMPLE(
    new Request("https://app.example/api/pay-rules/policy/sample", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const params = (turnId = TURN) => ({ params: Promise.resolve({ turnId }) });
const runRequest = (method: "GET" | "POST", site?: string) =>
  new Request(`https://app.example/api/pay-rules/policy/${TURN}`, {
    method,
    headers: site ? { "Sec-Fetch-Site": site } : {},
  });

const VIEW = {
  turnId: TURN,
  status: "running",
  endedReason: null,
  checklist: null,
  steps: [{ seq: 1, kind: "tool", label: "Store your policy", state: "done", stage: "open" }],
  documentId: DOC,
  proposalId: null,
};

const judgeRefusal = () => NextResponse.json({ error: "judge", retryable: false }, { status: 403 });

const saved = flags.policyOnboardEnabled;
beforeEach(() => {
  flags.policyOnboardEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.staffGate.mockReset().mockResolvedValue(null);
  mocks.startPolicyRun.mockReset().mockResolvedValue({ ok: true, turnId: TURN, documentId: DOC });
  mocks.readPolicyRun.mockReset().mockResolvedValue(VIEW);
  mocks.advancePolicyRun.mockReset().mockResolvedValue({ ok: true, view: VIEW, busy: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.policyOnboardEnabled = saved;
  vi.restoreAllMocks();
});

describe("POST /api/pay-rules/policy", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await upload({ site });
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses a request with no session, and answers not found while the switch is off", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await upload({ site: "same-origin" })).status).toBe(401);
    mocks.getSession.mockResolvedValue(SESSION);
    flags.policyOnboardEnabled = false;
    const res = await upload();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "disabled" });
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("refuses a judge before the switch, the body or the run", async () => {
    mocks.staffGate.mockResolvedValue(judgeRefusal());
    flags.policyOnboardEnabled = false;
    const res = await upload({ site: "same-origin" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("refuses a body with no length or one past the limit, and a file past the limit", async () => {
    expect((await upload({ length: "" })).status).toBe(400);
    expect((await upload({ length: "0" })).status).toBe(400);
    const res = await upload({ length: String(flags.policyLimits.maxBytes + 64 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    const big = new File([new Uint8Array(flags.policyLimits.maxBytes + 1)], "big.pdf", { type: "application/pdf" });
    expect((await upload({ files: [big] })).status).toBe(413);
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("refuses a form without exactly one file", async () => {
    const one = () => new File([PDF], "a.pdf", { type: "application/pdf" });
    expect((await upload({ files: [one(), one()] })).status).toBe(400);
    expect((await upload({ files: [], extra: { file: "text" } })).status).toBe(400);
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("passes the file to the run and answers with the run's ids", async () => {
    const res = await upload({ site: "same-origin" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ turnId: TURN, documentId: DOC });
    const [session, file] = mocks.startPolicyRun.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(file).toMatchObject({ name: "policy.pdf", type: "application/pdf" });
    expect(Array.from(file.bytes as Uint8Array)).toEqual(Array.from(PDF));
  });

  it("answers each refusal with its own status", async () => {
    const statuses: Record<string, number> = {
      disabled: 404,
      too_large: 413,
      unsupported: 415,
      too_many_pages: 422,
      limit: 429,
      used_elsewhere: 409,
      busy: 409,
    };
    for (const [error, status] of Object.entries(statuses)) {
      mocks.startPolicyRun.mockResolvedValueOnce({ ok: false, error });
      const res = await upload();
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("answers forbidden for a non-member and unavailable for anything else, logging only the name", async () => {
    const forbidden = new Error("not a member of sub-test");
    forbidden.name = "ForbiddenError";
    mocks.startPolicyRun.mockRejectedValueOnce(forbidden);
    expect((await upload()).status).toBe(403);
    mocks.startPolicyRun.mockRejectedValueOnce(new TypeError("secret detail"));
    const res = await upload();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret detail");
  });
});

describe("POST /api/pay-rules/policy/sample", () => {
  it("refuses a cross-site post, no session and the switch off before starting anything", async () => {
    expect((await sample({ name: "harrow-flats-pay-policy" }, "cross-site")).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await sample({ name: "harrow-flats-pay-policy" })).status).toBe(401);
    flags.policyOnboardEnabled = false;
    expect((await sample({ name: "harrow-flats-pay-policy" })).status).toBe(404);
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("refuses a judge before reading the name or starting a run", async () => {
    mocks.staffGate.mockResolvedValue(judgeRefusal());
    const res = await sample("not json");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
  });

  it("starts only this repo's own samples, by name", async () => {
    for (const body of [{ name: "other" }, { name: "harrow-flats-pay-policy", extra: 1 }, {}, "not json", { name: "__proto__" }]) {
      const res = await sample(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(mocks.startPolicyRun).not.toHaveBeenCalled();
    for (const name of ["harrow-flats-pay-policy", "cedar-bend-pay-policy"]) {
      const res = await sample({ name });
      expect(res.status, name).toBe(201);
      expect(await res.json()).toEqual({ turnId: TURN, documentId: DOC });
    }
    const [[, harrow], [, cedar]] = mocks.startPolicyRun.mock.calls;
    expect(harrow).toMatchObject({ name: "harrow-flats-pay-policy.pdf", type: "application/pdf" });
    expect(cedar).toMatchObject({ name: "cedar-bend-pay-policy.pdf", type: "application/pdf" });
    // The bytes are a PDF.
    expect(new TextDecoder().decode((harrow.bytes as Uint8Array).slice(0, 5))).toBe("%PDF-");
  });

  it("answers the run's refusal with its status", async () => {
    mocks.startPolicyRun.mockResolvedValueOnce({ ok: false, error: "limit" });
    const res = await sample({ name: "cedar-bend-pay-policy" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit" });
  });
});

describe("/api/pay-rules/policy/[turnId]", () => {
  it("GET answers the run, not found for none, and nothing without a session or the switch", async () => {
    let res = await RUN(runRequest("GET"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: VIEW });
    expect(mocks.readPolicyRun).toHaveBeenCalledWith(SESSION, TURN);
    mocks.readPolicyRun.mockResolvedValueOnce(null);
    res = await RUN(runRequest("GET"), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await RUN(runRequest("GET"), params())).status).toBe(401);
    flags.policyOnboardEnabled = false;
    expect((await RUN(runRequest("GET"), params())).status).toBe(404);
    expect(mocks.readPolicyRun).toHaveBeenCalledTimes(2);
    // Reading the run is not gated.
    expect(mocks.staffGate).not.toHaveBeenCalled();
  });

  it("POST refuses a judge before running any stage, and GET still reads for one", async () => {
    mocks.staffGate.mockResolvedValue(judgeRefusal());
    const res = await ADVANCE(runRequest("POST", "same-origin"), params());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.advancePolicyRun).not.toHaveBeenCalled();
    expect((await RUN(runRequest("GET"), params())).status).toBe(200);
    expect(mocks.staffGate).toHaveBeenCalledTimes(1);
  });

  it("POST runs the next stage, refusing a cross-site post first", async () => {
    expect((await ADVANCE(runRequest("POST", "cross-site"), params())).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    let res = await ADVANCE(runRequest("POST", "same-origin"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: VIEW, busy: false });
    expect(mocks.advancePolicyRun).toHaveBeenCalledWith(SESSION, TURN);
    mocks.advancePolicyRun.mockResolvedValueOnce({ ok: true, view: VIEW, busy: true });
    res = await ADVANCE(runRequest("POST"), params());
    expect(await res.json()).toEqual({ run: VIEW, busy: true });
    mocks.advancePolicyRun.mockResolvedValueOnce({ ok: false, error: "not_found" });
    expect((await ADVANCE(runRequest("POST"), params())).status).toBe(404);
    mocks.advancePolicyRun.mockRejectedValueOnce(new Error("boom"));
    res = await ADVANCE(runRequest("POST"), params());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    flags.policyOnboardEnabled = false;
    expect((await ADVANCE(runRequest("POST"), params())).status).toBe(404);
    expect(mocks.advancePolicyRun).toHaveBeenCalledTimes(4);
  });
});
