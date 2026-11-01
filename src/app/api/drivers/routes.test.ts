import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST as armPost } from "./[id]/arm/route";
import { POST as cardsPost } from "./[id]/cards/route";
import { POST as closePost } from "./[id]/cards/[cardId]/close/route";
import { POST as defaultPost } from "./[id]/cards/[cardId]/default/route";
import { POST as idsPost } from "./[id]/identities/route";
import { POST as driversPost } from "./route";
import { POST as suggestPost } from "../advances/suggest/route";
import { POST as takeBackPost } from "../advances/[id]/take-back/route";

// The driver money panel's routes and Take back, on the shared body shape: a cross-site post is
// refused first, then the advances switch, the login, every id in the path and the strict body,
// each before the service runs. A refusal answers with its category only; anything thrown is
// unavailable, never its text.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const DRIVER = "22222222-2222-4222-8222-222222222222";
const CARD = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  armDriver: vi.fn(),
  addIdentity: vi.fn(),
  addCard: vi.fn(),
  closeCard: vi.fn(),
  setDefaultCard: vi.fn(),
  takeBackAdvance: vi.fn(),
  readDeskLoads: vi.fn(),
  readDeskSuggestion: vi.fn(),
  createDriver: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/advances/arming", () => ({ armDriver: mocks.armDriver }));
vi.mock("@/lib/drivers/create", () => ({ createDriver: mocks.createDriver }));
vi.mock("@/lib/advances/identity", () => ({
  addIdentity: mocks.addIdentity,
  addCard: mocks.addCard,
  closeCard: mocks.closeCard,
  setDefaultCard: mocks.setDefaultCard,
}));
vi.mock("@/lib/tenant/context", () => ({
  withSessionTenant: async (_session: Session, fn: (q: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@/lib/advances/read", () => ({
  readDeskLoads: mocks.readDeskLoads,
  readDeskSuggestion: mocks.readDeskSuggestion,
}));
vi.mock("@/lib/advances/takeback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/advances/takeback")>()),
  takeBackAdvance: mocks.takeBackAdvance,
}));

// Each route names its own params; never stands for any of them.
type Handler = (request: Request, ctx: { params: Promise<never> }) => Promise<Response>;

function post(handler: Handler, params: Record<string, string>, body: unknown, site = "same-origin") {
  const request = new Request("https://app.example/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", "Sec-Fetch-Site": site },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handler(request, { params: Promise.resolve(params) as Promise<never> });
}

const saved = {
  advances: flags.advancesEnabled,
  takeback: flags.advanceTakeback.enabled,
  driverAdmin: flags.driverAdmin.enabled,
};

beforeEach(() => {
  flags.advancesEnabled = true;
  flags.advanceTakeback.enabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  for (const m of [mocks.armDriver, mocks.addIdentity, mocks.addCard, mocks.closeCard, mocks.setDefaultCard, mocks.takeBackAdvance]) {
    m.mockReset().mockResolvedValue({ ok: true, changed: true });
  }
});

afterEach(() => {
  flags.advancesEnabled = saved.advances;
  flags.advanceTakeback.enabled = saved.takeback;
  flags.driverAdmin.enabled = saved.driverAdmin;
  vi.restoreAllMocks();
});

describe("the driver money routes", () => {
  it("refuses a cross-site post before the switch or the session", async () => {
    flags.advancesEnabled = false;
    const res = await post(armPost as Handler, { id: DRIVER }, { armed: true }, "cross-site");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses everything while advances are off, before reading the session", async () => {
    flags.advancesEnabled = false;
    const res = await post(armPost as Handler, { id: DRIVER }, { armed: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.armDriver).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await post(armPost as Handler, { id: DRIVER }, { armed: true });
    expect(res.status).toBe(401);
    expect(mocks.armDriver).not.toHaveBeenCalled();
  });

  it("refuses a malformed id in the path, the driver's or the card's", async () => {
    expect((await post(armPost as Handler, { id: "nope" }, { armed: true })).status).toBe(400);
    expect((await post(closePost as Handler, { id: DRIVER, cardId: "x" }, {})).status).toBe(400);
    expect(mocks.armDriver).not.toHaveBeenCalled();
    expect(mocks.closeCard).not.toHaveBeenCalled();
  });

  it("refuses a body that is not exactly the route's shape", async () => {
    const bad: [Handler, Record<string, string>, unknown][] = [
      [armPost as Handler, { id: DRIVER }, { armed: "yes" }],
      [armPost as Handler, { id: DRIVER }, { armed: true, extra: 1 }],
      [armPost as Handler, { id: DRIVER }, { armed: true, note: "x".repeat(241) }],
      [armPost as Handler, { id: DRIVER }, "{not json"],
      [idsPost as Handler, { id: DRIVER }, { system: "payroll", externalId: "A1" }],
      [idsPost as Handler, { id: DRIVER }, { system: "tms", externalId: "has space" }],
      [cardsPost as Handler, { id: DRIVER }, { last4: "12a4", holderKind: "named", makeDefault: false }],
      [cardsPost as Handler, { id: DRIVER }, { last4: "1234", holderKind: "pool", makeDefault: false }],
      [cardsPost as Handler, { id: DRIVER }, { last4: "1234", holderKind: "named", makeDefault: false, token: "t" }],
      [defaultPost as Handler, { id: DRIVER, cardId: CARD }, { makeDefault: true }],
    ];
    for (const [handler, params, body] of bad) {
      const res = await post(handler, params, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", retryable: false });
    }
    for (const m of [mocks.armDriver, mocks.addIdentity, mocks.addCard, mocks.setDefaultCard]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("runs each service with lower-case ids and the parsed body", async () => {
    const upper = DRIVER.toUpperCase();
    expect((await post(armPost as Handler, { id: upper }, { armed: true })).status).toBe(200);
    expect(mocks.armDriver).toHaveBeenCalledWith(SESSION, DRIVER, { armed: true, note: null });
    await post(idsPost as Handler, { id: DRIVER }, { system: "tms", externalId: "TMS-9" });
    expect(mocks.addIdentity).toHaveBeenCalledWith(SESSION, DRIVER, { system: "tms", externalId: "TMS-9" });
    await post(cardsPost as Handler, { id: DRIVER }, { last4: "1234", holderKind: "named", makeDefault: true });
    expect(mocks.addCard).toHaveBeenCalledWith(SESSION, DRIVER, {
      last4: "1234",
      holderKind: "named",
      makeDefault: true,
      portalName: null,
    });
    await post(closePost as Handler, { id: DRIVER, cardId: CARD.toUpperCase() }, {});
    expect(mocks.closeCard).toHaveBeenCalledWith(SESSION, DRIVER, CARD);
    await post(defaultPost as Handler, { id: DRIVER, cardId: CARD }, {});
    expect(mocks.setDefaultCard).toHaveBeenCalledWith(SESSION, DRIVER, CARD);
  });

  it("answers a refusal with its category and status, and anything thrown as unavailable", async () => {
    mocks.armDriver.mockResolvedValue({ ok: false, category: "role", retryable: false });
    let res = await post(armPost as Handler, { id: DRIVER }, { armed: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "role", retryable: false });
    mocks.addIdentity.mockResolvedValue({ ok: false, category: "identity_taken", retryable: false });
    res = await post(idsPost as Handler, { id: DRIVER }, { system: "tms", externalId: "TMS-9" });
    expect(res.status).toBe(409);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.addCard.mockRejectedValue(new Error("duplicate key value violates unique constraint secret_detail"));
    res = await post(cardsPost as Handler, { id: DRIVER }, { last4: "1234", holderKind: "named", makeDefault: false });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
    expect(text).not.toContain("secret_detail");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain("secret_detail");
  });
});

describe("POST /api/advances/:id/take-back", () => {
  it("refuses while its own switch is off, before anything else", async () => {
    flags.advanceTakeback.enabled = false;
    const res = await post(takeBackPost as Handler, { id: DRIVER }, { amountCents: 100, reason: "duplicate" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.takeBackAdvance).not.toHaveBeenCalled();
  });

  it("refuses a reason off the list or an amount that is not whole cents", async () => {
    for (const body of [
      { amountCents: 100, reason: "because" },
      { amountCents: 1.5, reason: "duplicate" },
      { amountCents: -1, reason: "duplicate" },
      { amountCents: "100", reason: "duplicate" },
    ]) {
      expect((await post(takeBackPost as Handler, { id: DRIVER }, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.takeBackAdvance).not.toHaveBeenCalled();
  });

  it("runs the take-back with the parsed body", async () => {
    const res = await post(takeBackPost as Handler, { id: DRIVER }, { amountCents: 2_000, reason: "duplicate" });
    expect(res.status).toBe(200);
    expect(mocks.takeBackAdvance).toHaveBeenCalledWith(SESSION, DRIVER, { amountCents: 2_000, reason: "duplicate" });
  });
});

describe("POST /api/advances/suggest", () => {
  const LOAD = "44444444-4444-4444-8444-444444444444";
  const suggestion = { armed: true, maxCents: 30_000, suggestedCents: 30_000, feeCents: 500, load: null };

  beforeEach(() => {
    mocks.readDeskLoads.mockReset().mockResolvedValue([{ id: LOAD, number: "BR-L10001", deliveredOn: "2026-10-20" }]);
    mocks.readDeskSuggestion.mockReset().mockResolvedValue(suggestion);
  });

  it("answers the driver's loads and the engine's suggestion, with lower-case ids", async () => {
    const res = await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER.toUpperCase(), loadId: LOAD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      loads: [{ id: LOAD, number: "BR-L10001", deliveredOn: "2026-10-20" }],
      suggestion,
    });
    expect(mocks.readDeskSuggestion).toHaveBeenCalledWith({}, DRIVER, LOAD, expect.any(Date));
  });

  it("refuses an unknown driver or a load that is not theirs by category", async () => {
    mocks.readDeskSuggestion.mockResolvedValue("not_found");
    expect((await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER })).status).toBe(404);
    mocks.readDeskSuggestion.mockResolvedValue("load_not_drivers");
    const res = await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER, loadId: LOAD });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "load_not_drivers", retryable: false });
  });

  it("refuses while advances are off, a bad body, and no session, before reading", async () => {
    flags.advancesEnabled = false;
    expect((await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER })).status).toBe(403);
    flags.advancesEnabled = true;
    expect((await post(suggestPost as unknown as Handler, {}, { driverId: "x" })).status).toBe(400);
    expect((await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER, extra: 1 })).status).toBe(400);
    mocks.getSession.mockResolvedValue(null);
    expect((await post(suggestPost as unknown as Handler, {}, { driverId: DRIVER })).status).toBe(401);
    expect(mocks.readDeskSuggestion).not.toHaveBeenCalled();
  });
});

describe("POST /api/drivers", () => {
  const NEW_DRIVER = "55555555-5555-4555-8555-555555555555";
  const BODY = {
    code: "br-d27",
    firstName: "Ana",
    lastName: "Example",
    email: "Ana@Example.test",
    workerType: "company",
    payBasis: "per_mile",
    perMileCents: 62,
  };
  const add = (body: unknown, site = "same-origin") => post(driversPost as unknown as Handler, {}, body, site);

  beforeEach(() => {
    flags.driverAdmin.enabled = true;
    mocks.createDriver.mockReset().mockResolvedValue({ ok: true, changed: true, id: NEW_DRIVER });
  });

  it("refuses while driver admin is off, before the session or the body, even a direct post", async () => {
    flags.driverAdmin.enabled = false;
    const res = await add(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.createDriver).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post and a request with no session", async () => {
    expect((await add(BODY, "cross-site")).status).toBe(403);
    mocks.getSession.mockResolvedValue(null);
    expect((await add(BODY)).status).toBe(401);
    expect(mocks.createDriver).not.toHaveBeenCalled();
  });

  it("refuses a body that is not exactly a new driver", async () => {
    for (const body of [
      { ...BODY, perMileCents: 0 },
      { ...BODY, percentBps: 7_500 },
      { ...BODY, payBasis: "percent" },
      { ...BODY, code: "has space" },
      { ...BODY, email: "nope" },
      { ...BODY, moneyArmed: true },
      { ...BODY, tenantId: SESSION.tenantId },
      "{not json",
    ]) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", retryable: false });
    }
    expect(mocks.createDriver).not.toHaveBeenCalled();
  });

  it("runs the service with the parsed body and answers the new driver's id", async () => {
    const res = await add(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true, id: NEW_DRIVER });
    expect(mocks.createDriver).toHaveBeenCalledWith(SESSION, {
      ...BODY,
      code: "BR-D27",
      email: "ana@example.test",
      tankGallons: 200,
      ownInsurance: false,
      preferredLanguage: "en",
    });
  });

  it("answers a key already on file and a role refusal by category, and anything thrown as unavailable", async () => {
    for (const [category, status] of [
      ["code_taken", 409],
      ["email_taken", 409],
      ["role", 403],
      ["disabled", 403],
    ] as const) {
      mocks.createDriver.mockResolvedValueOnce({ ok: false, category, retryable: false });
      const res = await add(BODY);
      expect(res.status, category).toBe(status);
      expect(await res.json()).toEqual({ error: category, retryable: false });
    }
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createDriver.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "drivers_secret_detail"'));
    const res = await add(BODY);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
    expect(text).not.toContain("secret_detail");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain("secret_detail");
  });
});
