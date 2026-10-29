import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as handOff } from "./[id]/hand-off/route";
import { GET as detail } from "./[id]/route";
import { POST as sortAgain } from "./[id]/sort/route";
import { GET as list, POST as paste } from "./route";

// The Inbox routes' own checks, in order: a cross-site request is refused before the session is
// read, then the switch, the login, the body cap and the fields, each before the pipeline runs.
// Replies carry a category only, never an error's text or the message, and are never cached.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const MSG = "33333333-3333-4333-8333-333333333333";
const TEXT = "Need a $300 advance for diesel.";

const row = (status: string) => ({ id: MSG, status, channel: "paste" });

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  receiveMessage: vi.fn(),
  sortMessage: vi.fn(),
  handOffMessage: vi.fn(),
  listInbound: vi.fn(),
  readInbound: vi.fn(),
  readInboundDetail: vi.fn(),
  member: true,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/inbound/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound/pipeline")>()),
  receiveMessage: mocks.receiveMessage,
  sortMessage: mocks.sortMessage,
  handOffMessage: mocks.handOffMessage,
}));
vi.mock("@/lib/inbound/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound/store")>()),
  listInbound: mocks.listInbound,
  readInbound: mocks.readInbound,
  readInboundDetail: mocks.readInboundDetail,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({
    withTenant: async (_tenant: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({
        query: async () => (mocks.member ? [{ ok: 1 }] : []),
        execute: async () => 0,
      }),
  }),
}));

const saved = structuredClone(flags);
let logged: unknown[][] = [];

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.inboxEnabled = true;
  mocks.member = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.receiveMessage.mockReset().mockResolvedValue({ ok: true, duplicate: false, message: row("received") });
  mocks.sortMessage.mockReset().mockResolvedValue({ ok: true, inboundId: MSG, status: "triaged", category: null, attempts: 1 });
  mocks.handOffMessage.mockReset().mockResolvedValue({ ok: true, inboundId: MSG, status: "handed_off", conversationId: "c-1", turnId: "t-1", turnStatus: "done" });
  mocks.listInbound.mockReset().mockResolvedValue([row("triaged")]);
  mocks.readInbound.mockReset().mockResolvedValue(row("triaged"));
  mocks.readInboundDetail.mockReset().mockResolvedValue({ ...row("blocked"), text: TEXT, traceId: "tr", trace: [] });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  for (const line of logged) expect(line.map(String).join(" ")).not.toContain("diesel");
  vi.restoreAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return paste(
    new Request("https://app.example/api/inbound-messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.example/api/inbound-messages${path}`, { headers });
const press = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.example/api/inbound-messages${path}`, { method: "POST", headers });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/inbound-messages", () => {
  it("refuses a cross-site post before reading the session", async () => {
    const response = await post({ id: MSG, text: TEXT }, { "Sec-Fetch-Site": "cross-site" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses with the switch off before reading the session or the body", async () => {
    flags.inboxEnabled = false;
    const response = await post({ id: MSG, text: TEXT });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.receiveMessage).not.toHaveBeenCalled();
  });

  it("refuses without a login", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await post({ id: MSG, text: TEXT });
    expect(response.status).toBe(401);
    expect(mocks.receiveMessage).not.toHaveBeenCalled();
  });

  it("refuses a body that is not the paste's JSON, or is too large, before the pipeline runs", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ id: MSG, text: TEXT }, { "content-type": "text/plain" })).status).toBe(400);
    expect((await post({ id: "nope", text: TEXT })).status).toBe(400);
    expect((await post({ id: MSG })).status).toBe(400);
    expect((await post({ id: MSG, text: TEXT, driverId: MSG })).status).toBe(400);
    const big = await post({ id: MSG, text: "a".repeat(flags.inboxLimits.maxChars * 6 + 20_000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_long", retryable: false });
    expect(mocks.receiveMessage).not.toHaveBeenCalled();
  });

  it("stores the paste, sorts it in the same request and answers with the row as it stands", async () => {
    const response = await post({ id: MSG.toUpperCase(), text: TEXT, fromAddress: "a@b.example", subject: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      duplicate: false,
      message: row("triaged"),
      sort: { ok: true, inboundId: MSG, status: "triaged", category: null, attempts: 1 },
    });
    const [session, input] = mocks.receiveMessage.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(input).toMatchObject({ id: MSG.toUpperCase(), channel: "paste", text: TEXT, fromAddress: "a@b.example", subject: null, messageId: null });
    expect(input.receivedAt).toBeInstanceOf(Date);
    expect(mocks.sortMessage).toHaveBeenCalledWith(SESSION, MSG);
  });

  it("does not sort a repeated press of a message already sorted, held or failed", async () => {
    for (const status of ["triaged", "blocked", "failed", "handed_off"]) {
      mocks.receiveMessage.mockResolvedValue({ ok: true, duplicate: true, message: row(status) });
      const response = await post({ id: MSG, text: TEXT });
      expect(await response.json()).toEqual({ ok: true, duplicate: true, message: row(status), sort: null });
    }
    expect(mocks.sortMessage).not.toHaveBeenCalled();
  });

  it("keeps the stored message when the sort fails, with the sort's category only", async () => {
    mocks.sortMessage.mockRejectedValue(new Error("upstream said diesel"));
    mocks.readInbound.mockResolvedValue(row("received"));
    const response = await post({ id: MSG, text: TEXT });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      duplicate: false,
      message: row("received"),
      sort: { ok: false, category: "unavailable", retryable: true },
    });
    expect(logged).toContainEqual(["inbox step failed:", "sort", "Error"]);
  });

  it("answers a refusal with its status and category", async () => {
    mocks.receiveMessage.mockResolvedValue({ ok: false, category: "daily_cap", retryable: false });
    const capped = await post({ id: MSG, text: TEXT });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "daily_cap", retryable: false });
    mocks.receiveMessage.mockResolvedValue({ ok: false, category: "too_long", retryable: false });
    expect((await post({ id: MSG, text: TEXT })).status).toBe(413);
    mocks.receiveMessage.mockRejectedValue(new Error("upstream words"));
    const broke = await post({ id: MSG, text: TEXT });
    expect(broke.status).toBe(503);
    expect(await broke.json()).toEqual({ error: "unavailable", retryable: true });
  });
});

describe("GET /api/inbound-messages and /[id]", () => {
  it("lists the carrier's messages for a member, never cached", async () => {
    const response = await list(get(""));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, messages: [row("triaged")] });
  });

  it("refuses a cross-site read, the switch off and a non-member", async () => {
    expect((await list(get("", { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.member = false;
    expect(await (await list(get(""))).json()).toEqual({ error: "forbidden", retryable: false });
    flags.inboxEnabled = false;
    expect(await (await detail(get(`/${MSG}`), params(MSG))).json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.listInbound).not.toHaveBeenCalled();
    expect(mocks.readInboundDetail).not.toHaveBeenCalled();
  });

  it("answers one message with its text, and a missing or malformed one by category", async () => {
    const response = await detail(get(`/${MSG}`), params(MSG.toUpperCase()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, message: { id: MSG, status: "blocked", text: TEXT } });
    expect(mocks.readInboundDetail.mock.calls[0][1]).toBe(MSG);
    expect((await detail(get("/x"), params("x"))).status).toBe(400);
    mocks.readInboundDetail.mockResolvedValue(null);
    expect((await detail(get(`/${MSG}`), params(MSG))).status).toBe(404);
  });
});

describe("POST /api/inbound-messages/[id]/sort and /hand-off", () => {
  it("runs the step for a member with the id lowercased", async () => {
    const sorted = await sortAgain(press(`/${MSG}/sort`), params(MSG.toUpperCase()));
    expect(sorted.status).toBe(200);
    expect(mocks.sortMessage).toHaveBeenCalledWith(SESSION, MSG);
    const handed = await handOff(press(`/${MSG}/hand-off`), params(MSG));
    expect(await handed.json()).toMatchObject({ ok: true, status: "handed_off", conversationId: "c-1" });
    expect(mocks.handOffMessage).toHaveBeenCalledWith(SESSION, MSG);
  });

  it("refuses cross-site, switched off, signed out and malformed presses before the step", async () => {
    expect((await sortAgain(press(`/${MSG}/sort`, { "Sec-Fetch-Site": "same-site" }), params(MSG))).status).toBe(403);
    flags.inboxEnabled = false;
    expect(await (await handOff(press(`/${MSG}/hand-off`), params(MSG))).json()).toEqual({ error: "disabled", retryable: false });
    flags.inboxEnabled = true;
    mocks.getSession.mockResolvedValue(null);
    expect((await sortAgain(press(`/${MSG}/sort`), params(MSG))).status).toBe(401);
    mocks.getSession.mockResolvedValue(SESSION);
    expect((await handOff(press("/x/hand-off"), params("x"))).status).toBe(400);
    expect(mocks.sortMessage).not.toHaveBeenCalled();
    expect(mocks.handOffMessage).not.toHaveBeenCalled();
  });

  it("answers the step's refusal with its category", async () => {
    mocks.handOffMessage.mockResolvedValue({ ok: false, category: "not_ready", retryable: false });
    const response = await handOff(press(`/${MSG}/hand-off`), params(MSG));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_ready", retryable: false });
    mocks.sortMessage.mockResolvedValue({ ok: false, category: "busy", retryable: true });
    expect(await (await sortAgain(press(`/${MSG}/sort`), params(MSG))).json()).toEqual({ error: "busy", retryable: true });
  });
});
