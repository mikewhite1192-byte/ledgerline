// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadLimitError } from "@/lib/data/read";
import { DbError } from "@/lib/db";
import { InputError } from "@/lib/rules-engine";
import { ForbiddenError } from "@/lib/tenant/context";
import DriversPage from "./page";

// The /drivers page's read failures: each one the read can raise is shown as unreadable, never as
// an empty list and never a crash; anything else is raised. No database: the tenant read is mocked
// to fail.

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

const show = async () => render(await DriversPage({ searchParams: Promise.resolve({}) }));

afterEach(() => {
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
