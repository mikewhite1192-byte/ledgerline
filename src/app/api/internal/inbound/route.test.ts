import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The internal inbound route's gates, with the pipeline a stand-in: the cross-site check and both
// switches answer before the key is read, the key is checked (one fresh re-read) before the body,
// the body is parsed strictly, a carrier without its service login is refused, and replies carry
// a category only. No database and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const MSG = "33333333-3333-4333-8333-333333333333";
const KEY = "Zk3".repeat(16);
const SERVICE: Session = { sub: `service:sweep:${TENANT}`, email: "sweep@example.test", tenantId: TENANT };
const BODY = {
  tenantId: TENANT,
  messageId: "0100018c0example0messageid",
  fromAddress: "pat@example.net",
  subject: "Lumper at the dock",
  text: "Need a $300 advance for diesel.",
  receivedAt: "2026-11-02T16:00:00.000Z",
};

const mocks = vi.hoisted(() => ({
  inboundKey: vi.fn(),
  serviceSession: vi.fn(),
  receiveMessage: vi.fn(),
  sortMessage: vi.fn(),
  readInbound: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({}),
}));
vi.mock("@/lib/sweep/service-session", () => ({ serviceSession: mocks.serviceSession }));
vi.mock("@/lib/inbound/internal-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound/internal-key")>()),
  inboundKey: mocks.inboundKey,
}));
vi.mock("@/lib/inbound/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound/pipeline")>()),
  receiveMessage: mocks.receiveMessage,
  sortMessage: mocks.sortMessage,
}));
vi.mock("@/lib/tenant/context", () => ({
  withSessionTenant: async (_s: Session, fn: (q: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@/lib/inbound/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound/store")>()),
  readInbound: mocks.readInbound,
}));

const saved = structuredClone(flags);
let logged: string[] = [];

function post(body: unknown, headers: Record<string, string> = { "x-inbound-key": KEY }) {
  return new Request("https://app.example/api/internal/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.inboundEmailEnabled = true;
  flags.inboxEnabled = true;
  mocks.inboundKey.mockReset().mockResolvedValue(KEY);
  mocks.serviceSession.mockReset().mockResolvedValue(SERVICE);
  mocks.receiveMessage.mockReset().mockResolvedValue({ ok: true, duplicate: false, message: { id: MSG, status: "received" } });
  mocks.sortMessage.mockReset().mockResolvedValue({ ok: true, inboundId: MSG, status: "triaged", category: null, attempts: 1 });
  mocks.readInbound.mockReset().mockResolvedValue({ id: MSG, status: "triaged" });
  logged = [];
  for (const level of ["error", "info", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  for (const line of logged) {
    expect(line).not.toContain("diesel");
    expect(line).not.toContain(KEY);
  }
  vi.restoreAllMocks();
});

describe("POST /api/internal/inbound", () => {
  it("the internal inbound route refuses without the switch, with a bad key, and for an unknown carrier", async () => {
    flags.inboundEmailEnabled = false;
    let res = await POST(post(BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    flags.inboundEmailEnabled = true;
    flags.inboxEnabled = false;
    res = await POST(post(BODY));
    expect((await res.json()).error).toBe("disabled");
    // Neither switch read the key.
    expect(mocks.inboundKey).not.toHaveBeenCalled();
    flags.inboxEnabled = true;

    // A wrong key, after one fresh re-read that also does not match.
    res = await POST(post(BODY, { "x-inbound-key": "W".repeat(48) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.inboundKey).toHaveBeenCalledTimes(2);
    expect(mocks.inboundKey.mock.calls[1][1]).toEqual({ fresh: true });
    res = await POST(post(BODY, {}));
    expect(res.status).toBe(403);

    // A carrier without its service login.
    mocks.serviceSession.mockResolvedValueOnce(null);
    res = await POST(post(BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.receiveMessage).not.toHaveBeenCalled();
  });

  it("refuses a cross-site call before anything else", async () => {
    const res = await POST(post(BODY, { "x-inbound-key": KEY, "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(mocks.inboundKey).not.toHaveBeenCalled();
  });

  it("answers not configured, retryable, when there is no key to check against", async () => {
    mocks.inboundKey.mockResolvedValueOnce(null);
    let res = await POST(post(BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured", retryable: true });
    mocks.inboundKey.mockRejectedValueOnce(new Error("boom"));
    res = await POST(post(BODY));
    expect(res.status).toBe(503);
  });

  it("takes a rotated key after one fresh read", async () => {
    const rotated = "Rq7".repeat(16);
    mocks.inboundKey.mockResolvedValueOnce(KEY).mockResolvedValueOnce(rotated);
    const res = await POST(post(BODY, { "x-inbound-key": rotated }));
    expect(res.status).toBe(202);
  });

  it("refuses a body that is not exactly the poster's shape", async () => {
    for (const bad of [
      { ...BODY, tenantId: "acme" },
      { ...BODY, messageId: "" },
      { ...BODY, receivedAt: "yesterday" },
      { ...BODY, extra: 1 },
      { ...BODY, text: 7 },
      Object.fromEntries(Object.entries(BODY).filter(([k]) => k !== "subject")),
    ]) {
      const res = await POST(post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.serviceSession).not.toHaveBeenCalled();
  });

  it("stores the message as an email under the service login, sorts it, and answers 202 with its id and status", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: MSG, status: "triaged" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [session, input] = mocks.receiveMessage.mock.calls[0];
    expect(session).toEqual(SERVICE);
    expect(input).toMatchObject({
      channel: "email",
      messageId: BODY.messageId,
      fromAddress: BODY.fromAddress,
      subject: BODY.subject,
      text: BODY.text,
    });
    expect(input.receivedAt.toISOString()).toBe(BODY.receivedAt);
    expect(mocks.sortMessage).toHaveBeenCalledWith(SERVICE, MSG);
  });

  it("answers a repeated message with the row already there, without sorting it again", async () => {
    mocks.receiveMessage.mockResolvedValueOnce({ ok: true, duplicate: true, message: { id: MSG, status: "triaged" } });
    const res = await POST(post(BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: MSG, status: "triaged" });
    expect(mocks.sortMessage).not.toHaveBeenCalled();
  });

  it("keeps the 202 when the sort fails, and passes the receive's refusal through as a category", async () => {
    mocks.sortMessage.mockRejectedValueOnce(new Error("upstream said diesel"));
    mocks.readInbound.mockResolvedValueOnce({ id: MSG, status: "failed" });
    let res = await POST(post(BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: MSG, status: "failed" });

    mocks.receiveMessage.mockResolvedValueOnce({ ok: false, category: "daily_cap", retryable: false });
    res = await POST(post(BODY));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily_cap", retryable: false });
  });

  it("answers unavailable, retryable, with the error's name only in the log", async () => {
    mocks.receiveMessage.mockRejectedValueOnce(Object.assign(new Error("row text diesel"), { name: "TypeError" }));
    const res = await POST(post(BODY));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({ error: "unavailable", retryable: true });
    expect(logged.join("\n")).toContain("TypeError");
  });
});
