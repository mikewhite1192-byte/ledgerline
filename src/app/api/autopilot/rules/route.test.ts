import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET, POST } from "./route";

// The autopilot rules route's gates, with the save and the read stand-ins and the parse real: the
// cross-site check and the switch answer before the session is read, a demo visitor is refused
// before any database call, only an admin saves, a bad body is named by its field alone, and an
// error's text never reaches the reply. The save itself is proven against a real database in
// src/lib/autopilot/autopilot-rules.db.test.ts. No database and no network here.

const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
const RULE = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "invoice_post",
  mode: "auto",
  maxCents: 1_000,
  dayMaxCents: 5_000,
  dayMaxCount: 2,
  driverDayMaxCents: null,
  version: 3,
  updatedAt: "2026-11-02T16:00:00.000Z",
};
const SAVE = { kind: "invoice_post", mode: "auto", maxCents: 1_000, dayMaxCents: 5_000, dayMaxCount: 2, expectedVersion: 2 };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  assertMembership: vi.fn(),
  staffGate: vi.fn(),
  readRole: vi.fn(),
  saveRule: vi.fn(),
  readRules: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/auth/role", () => ({ readRole: mocks.readRole }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ withTenant: mocks.withTenant }) }));
vi.mock("@/lib/autopilot/rules-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/autopilot/rules-admin")>()),
  saveRule: mocks.saveRule,
  readRules: mocks.readRules,
}));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  assertMembership: mocks.assertMembership,
}));

const saved = flags.autopilotRules;

const call = (body: unknown, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  POST(
    new Request("https://app.example/api/autopilot/rules", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  flags.autopilotRules = { enabled: true };
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.staffGate.mockResolvedValue(null);
  mocks.readRole.mockResolvedValue("admin");
  mocks.withTenant.mockImplementation((_t: string, fn: (q: unknown) => unknown) => fn({}));
  mocks.saveRule.mockResolvedValue({ ok: true, rule: RULE });
  mocks.readRules.mockResolvedValue({ rules: [RULE], kinds: [], pause: { paused: false }, startDate: "2026-10-31" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.autopilotRules = saved;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/autopilot/rules", () => {
  it("saves the parsed rule in the caller's own carrier and answers the saved rule, uncached", async () => {
    const res = await call(SAVE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, rule: RULE });
    expect(mocks.withTenant.mock.calls[0][0]).toBe(TENANT);
    expect(mocks.assertMembership).toHaveBeenCalledWith({}, SESSION);
    expect(mocks.saveRule).toHaveBeenCalledWith({}, SESSION, { ...SAVE, driverDayMaxCents: null }, expect.any(Date));
  });

  it("says when a save changed nothing", async () => {
    mocks.saveRule.mockResolvedValueOnce({ ok: true, rule: RULE, unchanged: true });
    const res = await call(SAVE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rule: RULE, unchanged: true });
  });

  it("answers 404 while the switch is off, before reading the session", async () => {
    flags.autopilotRules = { enabled: false };
    const off = await call(SAVE);
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it("refuses cross-site and no session before any database call", async () => {
    const cross = await call(SAVE, { "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call(SAVE)).status).toBe(401);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("refuses a demo visitor at the staff gate before any database call or body read", async () => {
    mocks.staffGate.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await call(SAVE);
    expect(res.status).toBe(403);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it("refuses staff with role, even for a body that does not parse", async () => {
    mocks.readRole.mockResolvedValue("staff");
    for (const body of [SAVE, { nope: 1 }]) {
      const res = await call(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "role" });
    }
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it("names a bad body by its field only, and refuses bad JSON and an oversized body", async () => {
    const bad = await call({ ...SAVE, maxCents: -1 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_request", retryable: false, field: "maxCents" });
    for (const body of ["{not json", JSON.stringify({ ...SAVE, pad: "x".repeat(2_100) })]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", retryable: false, field: "body" });
    }
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it("refuses Auto on a never-alone kind and a limit over the ceiling, with the ceiling", async () => {
    const never = await call({ ...SAVE, kind: "settlement_approve" });
    expect(never.status).toBe(409);
    expect(await never.json()).toEqual({ error: "never_alone", retryable: false });
    const over = await call({ ...SAVE, dayMaxCount: flags.autopilot.kinds.invoice_post!.dayMaxCount + 1 });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "over_ceiling", retryable: false, ceiling: flags.autopilot.kinds.invoice_post });
    expect(mocks.saveRule).not.toHaveBeenCalled();
  });

  it("answers changed with the rule as it is now", async () => {
    mocks.saveRule.mockResolvedValueOnce({ ok: false, category: "changed", rule: RULE });
    const res = await call(SAVE);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "changed", retryable: false, rule: RULE });
  });

  it("answers a service login's refusal as forbidden", async () => {
    mocks.saveRule.mockResolvedValueOnce({ ok: false, category: "forbidden" });
    const res = await call(SAVE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
  });

  it("never sends an error's text to the client", async () => {
    mocks.saveRule.mockRejectedValueOnce(new Error("relation autopilot_rules row 22222222 secret"));
    const res = await call(SAVE);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toMatch(/secret|autopilot_rules|22222222/);
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
  });
});

describe("GET /api/autopilot/rules", () => {
  it("answers the carrier's rules to any member, uncached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ rules: [RULE], startDate: "2026-10-31" });
    expect(mocks.withTenant.mock.calls[0][0]).toBe(TENANT);
    expect(mocks.assertMembership).toHaveBeenCalledWith({}, SESSION);
    expect(mocks.readRole).not.toHaveBeenCalled();
  });

  it("answers 404 while the switch is off and 401 with no session", async () => {
    flags.autopilotRules = { enabled: false };
    expect((await GET()).status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.autopilotRules = { enabled: true };
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("refuses a login with no membership and never sends an error's text", async () => {
    const { ForbiddenError } = await import("@/lib/tenant/context");
    mocks.assertMembership.mockRejectedValueOnce(new ForbiddenError());
    expect((await GET()).status).toBe(403);
    mocks.readRules.mockRejectedValueOnce(new Error("select from autopilot_rules failed secret"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/secret|autopilot_rules/);
  });
});
