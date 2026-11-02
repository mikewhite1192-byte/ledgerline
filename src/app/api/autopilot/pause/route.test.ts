import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { POST } from "./route";

// The pause route's body and its answers, with the switch write a stand-in: a Pause carries
// nothing else, a Resume must name the pause it saw (an instant or null), and a Resume on a pause
// that changed since answers 409 changed. The write itself is proven against a real database in
// src/lib/autopilot/autopilot-rules.db.test.ts. No database and no network here.

const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const SEEN = "2026-11-02T16:00:00.000Z";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), staffGate: vi.fn(), setPaused: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.staffGate }));
vi.mock("@/lib/autopilot/state", () => ({ setPaused: mocks.setPaused }));

const saved = structuredClone(flags.autopilot);

const call = (body: unknown) =>
  POST(
    new Request("https://app.example/api/autopilot/pause", {
      method: "POST",
      headers: { "content-type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  flags.autopilot.enabled = true;
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.staffGate.mockResolvedValue(null);
  mocks.setPaused.mockImplementation(async (_s: Session, change: { paused: boolean }) => ({ ok: true, paused: change.paused }));
});

afterEach(() => {
  Object.assign(flags.autopilot, structuredClone(saved));
  vi.clearAllMocks();
});

describe("POST /api/autopilot/pause", () => {
  it("pauses with nothing else, and resumes naming the pause it saw", async () => {
    const paused = await call({ paused: true });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ ok: true, paused: true });
    expect(mocks.setPaused).toHaveBeenLastCalledWith(SESSION, { paused: true });
    for (const pausedAt of [SEEN, null]) {
      const resumed = await call({ paused: false, pausedAt });
      expect(resumed.status).toBe(200);
      expect(mocks.setPaused).toHaveBeenLastCalledWith(SESSION, { paused: false, pausedAt });
    }
  });

  it("refuses a Resume that names no pause, and any other body, before the write", async () => {
    for (const body of [
      { paused: false },
      { paused: false, pausedAt: 1 },
      { paused: false, pausedAt: "x".repeat(41) },
      { paused: true, pausedAt: SEEN },
      { paused: false, pausedAt: SEEN, more: 1 },
      { paused: "no" },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("answers 409 changed for a Resume on a pause that changed since", async () => {
    mocks.setPaused.mockResolvedValueOnce({ ok: false, category: "changed" });
    const res = await call({ paused: false, pausedAt: SEEN });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "changed", retryable: false });
  });
});
