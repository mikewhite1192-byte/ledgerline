import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The pay card check route's gates, with the check itself a stand-in: the cross-site check and the
// switches answer before any session is read, and a demo visitor (the judge role) is refused by the
// staff check before the body is read or the check runs. No database, no model and no network.

const TENANT = "11111111-1111-4111-8111-111111111111";
const SETTLEMENT = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const TRACE = "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f";
const CARD = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: TENANT };
// The eight bytes every PNG starts with, as strict base64.
const IMAGE = "iVBORw0KGgo=";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), checkPayCard: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here a caller is staff
// unless a test says it is a demo visitor (the judge role).
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/pay-cards/check", () => ({ checkPayCard: mocks.checkPayCard }));

const saved = { cards: flags.payCardsEnabled, ai: flags.aiEnabled };

const post = (body: unknown = { settlementId: SETTLEMENT, traceId: TRACE, image: IMAGE }, headers: Record<string, string> = {}) =>
  new Request("https://app.example/api/pay-cards", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  flags.payCardsEnabled = true;
  flags.aiEnabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.staffGate.mockResolvedValue(null);
  mocks.checkPayCard.mockResolvedValue({ ok: true, cardId: CARD, attempt: 1, status: "checked", category: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  flags.payCardsEnabled = saved.cards;
  flags.aiEnabled = saved.ai;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/pay-cards", () => {
  it("checks one card for a staff member and answers its outcome only", async () => {
    const res = await POST(post(undefined, { "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ cardId: CARD, attempt: 1, status: "checked", category: null });
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(mocks.checkPayCard).toHaveBeenCalledTimes(1);
    const [session, input] = mocks.checkPayCard.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(input.settlementId).toBe(SETTLEMENT);
    expect(input.traceId).toBe(TRACE);
    expect(Buffer.from(input.png).toString("base64")).toBe(IMAGE);
  });

  it("refuses a cross-site post and a switched-off check before reading the session", async () => {
    expect((await POST(post(undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    flags.payCardsEnabled = false;
    expect((await POST(post())).status).toBe(409);
    flags.payCardsEnabled = true;
    flags.aiEnabled = false;
    expect((await POST(post())).status).toBe(409);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.staffGate).not.toHaveBeenCalled();
    expect(mocks.checkPayCard).not.toHaveBeenCalled();
  });

  it("answers 401 with no session, before the staff check", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(post())).status).toBe(401);
    expect(mocks.staffGate).not.toHaveBeenCalled();
    expect(mocks.checkPayCard).not.toHaveBeenCalled();
  });

  // A check spends model cents and keeps a row, so a demo visitor is refused before any work.
  it("refuses a demo visitor (the judge role) before any work", async () => {
    mocks.staffGate.mockResolvedValue(NextResponse.json({ error: "judge", retryable: false }, { status: 403 }));
    const request = post(undefined, { "sec-fetch-site": "same-origin" });
    const res = await POST(request);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "judge", retryable: false });
    expect(mocks.staffGate).toHaveBeenCalledTimes(1);
    expect(mocks.staffGate).toHaveBeenCalledWith(SESSION);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.checkPayCard).not.toHaveBeenCalled();
  });
});
