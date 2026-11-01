// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import NewDriverPage from "./page";

// The Add driver page decides only what to show: the form for an admin while driver admin is on, a
// sentence for staff, the switched-off screen while it is off, and the read failures. The route
// checks everything again (src/app/api/drivers/routes.test.ts).

const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

// The request's transaction: one carrier in Chicago and one membership with this role.
function signedIn(role: "admin" | "staff" | "judge") {
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (/FROM tenants/.test(sql)) return [{ name: "Example Freight", timezone: "America/Chicago" }] as T[];
      if (/FROM memberships/.test(sql)) return [{ email: "ops@example.test", role }] as T[];
      throw new Error(`unexpected read: ${sql}`);
    },
    async execute() {
      throw new Error("the page writes nothing");
    },
  };
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
}

const saved = flags.driverAdmin.enabled;
const savedAdvances = flags.advancesEnabled;

beforeEach(() => {
  flags.driverAdmin.enabled = true;
  flags.advancesEnabled = true;
});

afterEach(() => {
  flags.driverAdmin.enabled = saved;
  flags.advancesEnabled = savedAdvances;
  mocks.withRequestTenant.mockReset();
  cleanup();
});

const show = async () => render(await NewDriverPage());

describe("/drivers/new", () => {
  it("shows an admin the form while driver admin is on", async () => {
    signedIn("admin");
    await show();
    expect(screen.getByRole("heading", { level: 1, name: "Add a driver" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add driver" })).toBeTruthy();
    expect(screen.getByLabelText("Driver code")).toBeTruthy();
    expect(screen.getByText(/starts not armed and with no card/)).toBeTruthy();
  });

  it("shows staff and a demo visitor a sentence and no form", async () => {
    for (const role of ["staff", "judge"] as const) {
      signedIn(role);
      await show();
      expect(screen.getByText("Only an admin adds a driver.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add driver" })).toBeNull();
      cleanup();
    }
  });

  it("shows the switched-off screen and no form while driver admin is off, for an admin too", async () => {
    flags.driverAdmin.enabled = false;
    signedIn("admin");
    await show();
    expect(screen.getByText("Adding drivers is off for this carrier")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add driver" })).toBeNull();
    expect(screen.queryByLabelText("Driver code")).toBeNull();
  });

  it("shows the switched-off screen and no form while advances are off, since the route then refuses every send", async () => {
    flags.advancesEnabled = false;
    signedIn("admin");
    await show();
    expect(screen.getByText("Adding drivers is off for this carrier")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add driver" })).toBeNull();
    expect(screen.queryByLabelText("Driver code")).toBeNull();
  });

  it("shows a failed read and a login with no carrier as such, never the form", async () => {
    mocks.withRequestTenant.mockRejectedValueOnce(new DbError("unavailable"));
    await show();
    expect(screen.getByText("Could not read your carrier's data")).toBeTruthy();
    cleanup();
    mocks.withRequestTenant.mockRejectedValueOnce(new ForbiddenError());
    await show();
    expect(screen.getByText("This login is not linked to a carrier")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add driver" })).toBeNull();
  });
});
