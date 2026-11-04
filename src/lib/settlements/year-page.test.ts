import { afterEach, describe, expect, it, vi } from "vitest";
import { DbError } from "../db";
import { withRequestTenant } from "../tenant/context";
import { readPaystubYearForPage } from "./year-page";

vi.mock("../tenant/context", () => ({ withRequestTenant: vi.fn() }));

// A fault in the paystub page's year read leaves the group out and logs only a category, never the
// raw error; the stub's own read is not involved.

const ID = "0b8e2c1a-4d5f-4a6b-9c7d-8e9f0a1b2c3d";

describe("readPaystubYearForPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(withRequestTenant).mockReset();
  });

  it("leaves the group out on a database fault and logs only its category", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(withRequestTenant).mockRejectedValue(new DbError("timeout", "57014"));
    expect(await readPaystubYearForPage(ID)).toBeNull();
    expect(log.mock.calls).toEqual([["paystub year read failed: database timeout"]]);
  });

  it("leaves the group out on a bad row and logs only the error's name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(withRequestTenant).mockRejectedValue(new Error("year is not a whole number: secret detail"));
    expect(await readPaystubYearForPage(ID)).toBeNull();
    expect(log.mock.calls).toEqual([["paystub year read failed: Error"]]);
  });

  it("passes a good read through", async () => {
    const year = {
      yearToDate: { year: 2026, paidCents: 100, stubs: 1, zone: "America/Chicago" },
      escrow: { balanceCents: 0, asOf: "paid" as const },
    };
    vi.mocked(withRequestTenant).mockResolvedValue(year);
    expect(await readPaystubYearForPage(ID)).toEqual(year);
  });
});
