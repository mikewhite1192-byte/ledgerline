import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { activeOn, driverMoneyStateOf } from "./active";
import { setDriverStatus, StatusBody, statusTransition } from "./status";

// The pure parts of a status change and the money gates' active read. The writes, the lock and the
// gates themselves are in status.db.test.ts and the executors' db tests.

const SESSION: Session = { sub: "sub-test", email: "admin@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const DRIVER = "22222222-2222-4222-8222-222222222222";

// A database that fails the test if anything reaches it.
const untouched: TenantDb = {
  withTenant: () => {
    throw new Error("the database was reached");
  },
};

const saved = flags.driverAdmin.enabled;
afterEach(() => {
  flags.driverAdmin.enabled = saved;
});

describe("statusTransition", () => {
  it("deactivates only a driver with no last day and reactivates only one with a last day", () => {
    expect(statusTransition(null, false)).toBe("deactivate");
    expect(statusTransition("2026-11-02", false)).toBe("noop");
    expect(statusTransition("2026-11-02", true)).toBe("reactivate");
    expect(statusTransition(null, true)).toBe("noop");
  });
});

describe("activeOn", () => {
  it("is active from the first day through the last, both included", () => {
    expect(activeOn("2026-01-01", null, "2026-11-02")).toBe(true);
    expect(activeOn("2026-01-01", "2026-11-02", "2026-11-02")).toBe(true);
    expect(activeOn("2026-01-01", "2026-11-01", "2026-11-02")).toBe(false);
    expect(activeOn("2026-11-03", null, "2026-11-02")).toBe(false);
    expect(activeOn("2026-11-02", null, "2026-11-02")).toBe(true);
  });

  it("reads anything that is not a calendar date as not active", () => {
    expect(activeOn(null, null, "2026-11-02")).toBe(false);
    expect(activeOn("2026-01-01", "", "2026-11-02")).toBe(false);
    expect(activeOn("2026-01-01", "2026-13-01", "2026-11-02")).toBe(false);
    expect(activeOn("2026-01-01", null, "not a day")).toBe(false);
    expect(activeOn("2026-01-01", undefined, "2026-11-02")).toBe(false);
  });

  it("names inactive before not armed, and only true arms", () => {
    expect(driverMoneyStateOf({ money_armed: true, active_from: "2026-01-01", active_to: null }, "2026-11-02")).toBe("ok");
    expect(driverMoneyStateOf({ money_armed: false, active_from: "2026-01-01", active_to: null }, "2026-11-02")).toBe("not_armed");
    expect(driverMoneyStateOf({ money_armed: true, active_from: "2026-01-01", active_to: "2026-11-01" }, "2026-11-02")).toBe(
      "inactive",
    );
    expect(driverMoneyStateOf({ money_armed: false, active_from: "2026-01-01", active_to: "2026-11-01" }, "2026-11-02")).toBe(
      "inactive",
    );
    const odd = { money_armed: "true" as unknown as boolean, active_from: "2026-01-01", active_to: null };
    expect(driverMoneyStateOf(odd, "2026-11-02")).toBe("not_armed");
  });
});

describe("StatusBody", () => {
  it("takes exactly a status change", () => {
    expect(StatusBody.safeParse({ active: false }).success).toBe(true);
    expect(StatusBody.safeParse({ active: false, effectiveOn: "2026-11-02", note: "moved" }).success).toBe(true);
    expect(StatusBody.safeParse({ active: true }).success).toBe(true);
    for (const body of [
      {},
      { active: "false" },
      { active: false, effectiveOn: "2026-11-31" },
      { active: false, effectiveOn: "Nov 2" },
      { active: false, note: "x".repeat(241) },
      { active: false, armed: true },
    ]) {
      expect(StatusBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("setDriverStatus before the database", () => {
  it("refuses while driver admin is off, and reaches nothing", async () => {
    flags.driverAdmin.enabled = false;
    expect(await setDriverStatus(SESSION, DRIVER, { active: false }, { db: untouched })).toEqual({
      ok: false,
      category: "disabled",
      retryable: false,
    });
  });

  it("refuses a bad id, a date on a reactivation, a bad date and a long note before the database", async () => {
    flags.driverAdmin.enabled = true;
    for (const [id, change] of [
      ["nope", { active: false }],
      ["2222abcd-2222-4222-8222-222222222222".toUpperCase(), { active: false }],
      [DRIVER, { active: true, effectiveOn: "2026-11-02" }],
      [DRIVER, { active: false, effectiveOn: "2026-02-30" }],
      [DRIVER, { active: false, note: "x".repeat(241) }],
      [DRIVER, { active: "no" as unknown as boolean }],
    ] as const) {
      expect(await setDriverStatus(SESSION, id, change, { db: untouched }), JSON.stringify(change)).toEqual({
        ok: false,
        category: "bad_request",
        retryable: false,
      });
    }
  });
});
