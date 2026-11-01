import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { createDriver } from "./create";

// The service's own checks before any read: the driver admin switch, then the body. Neither one
// opens a transaction. The database paths are in create.db.test.ts.

const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const BODY = {
  code: "BR-D27",
  firstName: "Ana",
  lastName: "Example",
  email: "ana@example.test",
  workerType: "company",
  payBasis: "per_mile",
  perMileCents: 62,
};

const withTenant = vi.fn();
const db = { withTenant } as unknown as TenantDb;
const saved = flags.driverAdmin.enabled;

beforeEach(() => {
  withTenant.mockReset().mockRejectedValue(new Error("no database in this test"));
  flags.driverAdmin.enabled = true;
});

afterEach(() => {
  flags.driverAdmin.enabled = saved;
});

describe("createDriver before the database", () => {
  it("refuses while driver admin is off, without opening a transaction", async () => {
    flags.driverAdmin.enabled = false;
    expect(await createDriver(SESSION, BODY, { db })).toEqual({ ok: false, category: "disabled", retryable: false });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("refuses a body that is not exactly a new driver, without opening a transaction", async () => {
    for (const bad of [
      null,
      "BR-D27",
      { ...BODY, perMileCents: undefined },
      { ...BODY, percentBps: 7_500 },
      { ...BODY, moneyArmed: true },
      { ...BODY, code: "no spaces allowed" },
    ]) {
      expect(await createDriver(SESSION, bad, { db }), JSON.stringify(bad)).toEqual({
        ok: false,
        category: "bad_request",
        retryable: false,
      });
    }
    expect(withTenant).not.toHaveBeenCalled();
  });
});
