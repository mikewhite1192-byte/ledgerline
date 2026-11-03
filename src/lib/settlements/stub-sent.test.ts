import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { doneNote } from "../../components/settlements/action-button";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { markStubSent, stubSummary, type StubSummaryInput } from "./stub-sent";

// The stub's one line, written by code from the stored totals: no clock, no database, no rounding.
// The service's refusals before any database work, with a database that throws if touched.

const BASE: StubSummaryInput = {
  driverName: "Rosa Delgado",
  driverCode: "BR-D07",
  periodEnd: "2026-11-01",
  grossCents: 284_000,
  deductionsCents: 61_500,
  netCents: 222_500,
  carryForwardCents: 0,
  paidOn: "2026-11-03",
};

const trap: TenantDb = {
  withTenant: () => {
    throw new Error("the database was touched");
  },
} as unknown as TenantDb;
const SESSION: Session = { sub: "staff-sub", email: "", tenantId: "00000000-0000-4000-8000-000000000001" };
const ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date(Date.UTC(2026, 10, 3, 15, 0, 0));
const saved = structuredClone(flags);

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
});

describe("stubSummary", () => {
  it("words a normal stub from its stored totals", () => {
    expect(stubSummary(BASE)).toBe(
      "Pay stub for Rosa Delgado (BR-D07), week ending Nov 1, 2026: gross $2,840.00, deductions $615.00, net $2,225.00. Paid Nov 3, 2026.",
    );
  });

  it("says what carries to next week on a zero-net stub", () => {
    expect(stubSummary({ ...BASE, grossCents: 10_000, deductionsCents: 15_000, netCents: 0, carryForwardCents: 5_000 })).toBe(
      "Pay stub for Rosa Delgado (BR-D07), week ending Nov 1, 2026: gross $100.00, deductions $150.00, net $0.00; $50.00 carried to next week. Paid Nov 3, 2026.",
    );
  });

  it("writes every cent as stored, with no rounding", () => {
    expect(stubSummary({ ...BASE, grossCents: 123_457, deductionsCents: 1, netCents: 123_456 })).toBe(
      "Pay stub for Rosa Delgado (BR-D07), week ending Nov 1, 2026: gross $1,234.57, deductions $0.01, net $1,234.56. Paid Nov 3, 2026.",
    );
  });

  it("refuses an amount that is not whole cents instead of guessing", () => {
    expect(() => stubSummary({ ...BASE, netCents: 100.5 })).toThrow(RangeError);
  });
});

describe("markStubSent before any database work", () => {
  it("is disabled while the switch is off, and while settlements are off", async () => {
    flags.settlementsEnabled = true;
    flags.stubSent.enabled = false;
    expect(await markStubSent(trap, SESSION, ID, NOW)).toEqual({ ok: false, category: "disabled", retryable: false });
    flags.stubSent.enabled = true;
    flags.settlementsEnabled = false;
    expect(await markStubSent(trap, SESSION, ID, NOW)).toEqual({ ok: false, category: "disabled", retryable: false });
  });

  it("refuses an id that is not a canonical uuid", async () => {
    flags.settlementsEnabled = true;
    flags.stubSent.enabled = true;
    for (const bad of ["", "not-a-uuid", ID.toUpperCase(), `${ID} `]) {
      expect(await markStubSent(trap, SESSION, bad, NOW)).toEqual({ ok: false, category: "bad_request", retryable: false });
    }
  });

  it("ships on (released by the owner, D-071)", () => {
    expect(saved.stubSent.enabled).toBe(true);
  });
});

describe("the Mark stub sent button's note", () => {
  it("is one fixed sentence", () => {
    expect(doneNote("stub_sent", { ok: true, already: true, sentAt: "2026-11-03T15:00:00.000Z" })).toBe(
      "Recorded: the stub was marked sent.",
    );
  });
});
