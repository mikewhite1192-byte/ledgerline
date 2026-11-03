import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Param, Queryable, TenantDb } from "../db";
import { armTransition } from "./arming";
import { requestFromDesk, type DeskDeps } from "./desk";
import { newCardToken, normalizePortalName, portalNameOf } from "./identity";
import { deskRequestText, suggestionInput, suggestionLine } from "./request";
import { takebackPlan } from "./takeback";
import { TAKEBACK_REASONS, isTakebackReason, takebackReasonWords } from "./takeback-words";

describe("arming a driver", () => {
  it("changes only when the wanted state differs", () => {
    expect(armTransition(false, true)).toBe("arm");
    expect(armTransition(true, false)).toBe("disarm");
    expect(armTransition(true, true)).toBe("noop");
    expect(armTransition(false, false)).toBe("noop");
  });
});

describe("a take-back's plan", () => {
  const paid = {
    status: "paid" as const,
    amountCents: 30_000,
    feeCents: 500,
    recoveredCents: 10_000,
    takenBackCents: 0,
    takenBackAt: null,
  };
  const CAP = 100_000;

  it("records a paid advance's amount up to what is still owed", () => {
    expect(takebackPlan(paid, [], 20_500, CAP)).toEqual({ kind: "record", cents: 20_500 });
    expect(takebackPlan(paid, [], 1, CAP)).toEqual({ kind: "record", cents: 1 });
  });

  it("refuses more than is still owed, more than the switch's cap, and zero on a paid advance", () => {
    expect(takebackPlan(paid, [], 20_501, CAP)).toEqual({ kind: "refuse", category: "over_bound" });
    expect(takebackPlan(paid, [], 20_000, 19_999)).toEqual({ kind: "refuse", category: "over_bound" });
    expect(takebackPlan(paid, [], 0, CAP)).toEqual({ kind: "refuse", category: "bad_request" });
  });

  it("refuses an amount that is not a whole number of cents", () => {
    expect(takebackPlan(paid, [], -1, CAP)).toEqual({ kind: "refuse", category: "bad_request" });
    expect(takebackPlan(paid, [], 1.5, CAP)).toEqual({ kind: "refuse", category: "bad_request" });
    expect(takebackPlan(paid, [], Number.NaN, CAP)).toEqual({ kind: "refuse", category: "bad_request" });
  });

  it("cancels an advance not yet paid when no payout may have moved money", () => {
    for (const status of ["requested", "approved"] as const) {
      expect(takebackPlan({ ...paid, status }, [], 0, CAP)).toEqual({ kind: "cancel" });
      expect(takebackPlan({ ...paid, status }, [{ state: "failed" }], 0, CAP)).toEqual({ kind: "cancel" });
    }
  });

  it("refuses an advance whose payout is in flight or of unknown outcome", () => {
    for (const state of ["reserved", "sent", "unknown", "confirmed"] as const) {
      expect(takebackPlan({ ...paid, status: "approved" }, [{ state }], 0, CAP)).toEqual({
        kind: "refuse",
        category: "not_takeable",
      });
    }
  });

  it("refuses a rejected or cancelled advance that was never taken back", () => {
    for (const status of ["rejected", "cancelled"] as const) {
      expect(takebackPlan({ ...paid, status }, [], 100, CAP)).toEqual({ kind: "refuse", category: "not_takeable" });
    }
  });

  it("is once only: the same amount again is the same take-back, a different one is refused", () => {
    const done = { ...paid, takenBackCents: 5_000, takenBackAt: "2026-10-20T15:00:00.000Z" };
    expect(takebackPlan(done, [], 5_000, CAP)).toEqual({ kind: "same" });
    expect(takebackPlan(done, [], 4_000, CAP)).toEqual({ kind: "refuse", category: "already_taken_back" });
    const cancelled = { ...paid, status: "cancelled" as const, takenBackAt: "2026-10-20T15:00:00.000Z" };
    expect(takebackPlan(cancelled, [], 0, CAP)).toEqual({ kind: "same" });
    expect(takebackPlan(cancelled, [], 700, CAP)).toEqual({ kind: "same" });
  });
});

describe("take-back reasons", () => {
  it("knows its closed list and words each reason", () => {
    expect(TAKEBACK_REASONS).toEqual(["driver_request", "duplicate", "wrong_driver", "wrong_load", "other"]);
    expect(isTakebackReason("duplicate")).toBe(true);
    expect(isTakebackReason("constructor")).toBe(false);
    expect(isTakebackReason(7)).toBe(false);
    expect(takebackReasonWords("wrong_driver")).toBe("Paid to the wrong driver");
    expect(takebackReasonWords("cancelled_trip")).toBe("Load cancelled, booked as money the driver owes");
    expect(isTakebackReason("cancelled_trip")).toBe(false);
    expect(takebackReasonWords("toString")).toBe("Other");
    expect(takebackReasonWords("anything")).toBe("Other");
  });
});

describe("a driver's cards and ids", () => {
  it("draws a well formed card token from a random id", () => {
    expect(newCardToken(() => "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e")).toBe("fcs_card_0a1b2c3d4e5f40618728394a");
    expect(newCardToken()).toMatch(/^fcs_card_[0-9a-f]{24}$/);
    expect(() => newCardToken(() => "not-a-uuid")).toThrow(RangeError);
  });

  it("shows a portal name only on a generic card and only of the allowed shape", () => {
    expect(portalNameOf("generic", "POOL CARD 3")).toBe("POOL CARD 3");
    expect(portalNameOf("named", "POOL CARD 3")).toBeNull();
    expect(portalNameOf("generic", "pool card")).toBeNull();
    expect(portalNameOf("generic", null)).toBeNull();
    expect(portalNameOf("generic", "A")).toBeNull();
  });

  it("stores a typed portal name trimmed and upper case, and refuses one of another shape", () => {
    expect(normalizePortalName("  pool   card 3 ")).toBe("POOL CARD 3");
    expect(normalizePortalName("yard-2")).toBe("YARD-2");
    expect(normalizePortalName("Pool's card")).toBeNull();
    expect(normalizePortalName("x".repeat(41))).toBeNull();
    expect(normalizePortalName(42)).toBeNull();
  });
});

describe("the desk's suggestion", () => {
  it("suggests the engine's amount, with the load's cap and what is open on it", () => {
    expect(suggestionLine({ armed: true, suggestedCents: 30_000, load: null })).toBe("Suggested: $300.00");
    expect(suggestionLine({ armed: true, suggestedCents: 14_500, load: { capCents: 60_000, openOnLoadCents: 45_000 } })).toBe(
      "Suggested: $145.00 (cap $600.00, open $450.00)",
    );
  });

  it("says so instead of suggesting for a driver not armed or allowed nothing", () => {
    expect(suggestionLine({ armed: false, suggestedCents: 30_000, load: null })).toBe(
      "This driver is not armed to receive money yet. An admin can arm them on the driver page.",
    );
    expect(suggestionLine({ armed: true, suggestedCents: 0, load: null })).toBe(
      "The pay rules allow no advance for this driver right now.",
    );
  });

  it("fills the amount field as dollars and cents, and leaves it empty for nothing", () => {
    expect(suggestionInput(30_000)).toBe("300.00");
    expect(suggestionInput(14_505)).toBe("145.05");
    expect(suggestionInput(7)).toBe("0.07");
    expect(suggestionInput(0)).toBe("");
    expect(suggestionInput(-100)).toBe("");
    expect(suggestionInput(1.5)).toBe("");
  });

  it("names the load in the desk's sentence, and refuses a load number of another shape", () => {
    expect(deskRequestText(30_000, "BR-C01", "fuel", "BR-L10001")).toBe(
      "Request an advance of $300.00 for driver BR-C01 (fuel) for load BR-L10001",
    );
    expect(() => deskRequestText(30_000, "BR-C01", "fuel", "L 1; drop")).toThrow(RangeError);
    expect(() => deskRequestText(30_000, "BR-C01", "fuel", "")).toThrow(RangeError);
  });
});

describe("the request desk with a load", () => {
  const session = { sub: "sub-1", email: "a@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
  const driverId = "22222222-2222-4222-8222-222222222222";
  const loadId = "44444444-4444-4444-8444-444444444444";
  const turnId = "33333333-3333-4333-8333-333333333333";

  // A tenant database with one member, one driver and, when given, one load of that driver's.
  function fakeDb(loadNumber: string | null): TenantDb {
    const q: Queryable = {
      async query<T>(text: string, params?: Param[]): Promise<T[]> {
        if (text.includes("FROM memberships")) return [{ ok: 1 }] as T[];
        if (text.includes("FROM drivers")) return (params?.[0] === driverId ? [{ code: "BR-C01" }] : []) as T[];
        if (text.includes("FROM loads")) {
          const mine = loadNumber !== null && params?.[0] === loadId && params?.[1] === driverId;
          return (mine ? [{ load_number: loadNumber }] : []) as T[];
        }
        return [];
      },
      async execute() {
        return 0;
      },
    };
    return { withTenant: async (_tenant, fn) => fn(q) } as TenantDb;
  }

  function deps(db: TenantDb) {
    const run: string[] = [];
    const d: DeskDeps = {
      db,
      clock: () => Date.UTC(2026, 10, 2, 16),
      newId: () => turnId,
      open: async (_s, input) => ({ conversationId: "c-1", turnId: input.turnId }) as never,
      run: async (_s, _turn, text) => {
        run.push(text);
        return "done";
      },
    };
    return { d, run };
  }

  const saved = { a: flags.advancesEnabled, g: flags.agentEnabled, i: flags.aiEnabled };
  beforeEach(() => {
    flags.advancesEnabled = true;
    flags.agentEnabled = true;
    flags.aiEnabled = true;
  });
  afterEach(() => {
    flags.advancesEnabled = saved.a;
    flags.agentEnabled = saved.g;
    flags.aiEnabled = saved.i;
  });

  it("names the driver's own load, read back from the database", async () => {
    const { d, run } = deps(fakeDb("BR-L10001"));
    const out = await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel", loadId }, d);
    expect(out).toMatchObject({ ok: true, status: "done" });
    expect(run).toEqual(["Request an advance of $300.00 for driver BR-C01 (fuel) for load BR-L10001"]);
  });

  it("refuses a load that is not the driver's, and a stored number of another shape, without a turn", async () => {
    const other = deps(fakeDb(null));
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel", loadId }, other.d)).toEqual({
      ok: false,
      category: "not_found",
    });
    expect(other.run).toEqual([]);
    const odd = deps(fakeDb("l-1 <b>"));
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel", loadId }, odd.d)).toEqual({
      ok: false,
      category: "bad_request",
    });
    expect(odd.run).toEqual([]);
  });

  it("asks without a load when none is picked", async () => {
    const { d, run } = deps(fakeDb("BR-L10001"));
    await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel", loadId: null }, d);
    expect(run).toEqual(["Request an advance of $300.00 for driver BR-C01 (fuel)"]);
  });
});
