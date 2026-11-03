// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { ReadLimitError } from "@/lib/data/read";
import { DbError, type Queryable } from "@/lib/db";
import { InputError } from "@/lib/rules-engine";
import { ForbiddenError } from "@/lib/tenant/context";
import { CARDED_DRIVER_IDS, DRIVER_INSIGHT_INPUT } from "@/test/page-fixtures";
import DriversPage from "./page";

// The /drivers page's read failures: each one the read can raise is shown as unreadable, never as
// an empty list and never a crash; anything else is raised. No database: the tenant read is mocked
// to fail.

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn() }));
vi.mock("@/lib/data/driver-insights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/driver-insights")>()),
  readDriverInsightInput: async () => DRIVER_INSIGHT_INPUT,
  readCardedDrivers: async () => new Set(CARDED_DRIVER_IDS),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

const show = async () => render(await DriversPage({ searchParams: Promise.resolve({}) }));

const savedDriverAdmin = flags.driverAdmin.enabled;
const savedAdvances = flags.advancesEnabled;

afterEach(() => {
  flags.driverAdmin.enabled = savedDriverAdmin;
  flags.advancesEnabled = savedAdvances;
  mocks.withRequestTenant.mockReset();
  cleanup();
});

describe("/drivers read failures", () => {
  it("shows the read failed for a failed read, a read past its bound, an amount not in whole cents and a record the engine refuses", async () => {
    for (const err of [
      new DbError("unavailable"),
      new ReadLimitError(),
      new RangeError("a fuel line is not a deduction"),
      new InputError("a deficit total is not whole cents"),
    ]) {
      mocks.withRequestTenant.mockRejectedValueOnce(err);
      await show();
      expect(screen.getByText("Could not read your carrier's data"), err.name).toBeTruthy();
      expect(screen.queryByRole("search")).toBeNull();
      cleanup();
    }
  });

  it("says a person with no access to the carrier cannot see it", async () => {
    mocks.withRequestTenant.mockRejectedValueOnce(new ForbiddenError());
    await show();
    expect(screen.getByText("This login is not linked to a carrier")).toBeTruthy();
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("raises anything that is not a read problem", async () => {
    mocks.withRequestTenant.mockRejectedValueOnce(new TypeError("x is not a function"));
    await expect(DriversPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(TypeError);
  });
});

describe("/drivers Add driver link", () => {
  const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
  function signedIn(role: "admin" | "staff") {
    const q = {
      async query<T>(sql: string): Promise<T[]> {
        if (/FROM tenants/.test(sql)) return [{ name: "Example Freight", timezone: "America/Chicago" }] as T[];
        if (/FROM memberships/.test(sql)) return [{ email: "ops@example.test", role }] as T[];
        throw new Error(`unexpected read: ${sql}`);
      },
      async execute() {
        throw new Error("the page writes nothing");
      },
    } as Queryable;
    mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
  }
  const addLink = () => screen.queryByRole("link", { name: "Add driver" });

  it("shows an admin the link to the Add driver page while driver admin is on", async () => {
    flags.driverAdmin.enabled = true;
    flags.advancesEnabled = true;
    signedIn("admin");
    await show();
    expect(addLink()?.getAttribute("href")).toBe("/drivers/new");
  });

  it("hides it from an admin while advances are off, since its route then refuses every send", async () => {
    flags.driverAdmin.enabled = true;
    flags.advancesEnabled = false;
    signedIn("admin");
    await show();
    expect(screen.getByText("Rosa Delgado")).toBeTruthy();
    expect(addLink()).toBeNull();
  });

  it("hides it from staff, and from everyone while driver admin is off", async () => {
    flags.driverAdmin.enabled = true;
    flags.advancesEnabled = true;
    signedIn("staff");
    await show();
    expect(screen.getByText("Rosa Delgado")).toBeTruthy();
    expect(addLink()).toBeNull();
    cleanup();
    flags.driverAdmin.enabled = false;
    signedIn("admin");
    await show();
    expect(screen.getByText("Rosa Delgado")).toBeTruthy();
    expect(addLink()).toBeNull();
  });
});
