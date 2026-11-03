import { describe, expect, it } from "vitest";
import { MOCK_FAULTS, NO_FAULTS, faultsFor, type DemoFaults } from "./faults";
import { deletedReference, faultedHistory, faultedListRow, relabeled } from "./mock-faults";
import type { TmsHistoryRow, TmsListRow } from "./types";

const on = (fault: keyof DemoFaults): DemoFaults => ({ ...NO_FAULTS, [fault]: true });

const ROW: TmsListRow = {
  externalId: "syn:demo:ML1",
  createdAt: "2026-11-03T13:00:00.000Z",
  updatedAt: "2026-11-03T15:05:00.000Z",
  statusLabel: "In Transit",
  reference: "ML1",
  driverExternalId: "drv-1",
};

const DELIVERED: TmsHistoryRow = {
  externalId: "syn:demo:ML1:e3",
  field: "status",
  newValue: "Delivered",
  previousValue: "In Transit",
  changedBy: "Dispatch desk",
  at: { utc: "2026-11-03T19:45:00.000Z", local: "2026-11-03T13:45" },
};

describe("the sample dispatch system's fault switches", () => {
  it("offers only the switches it can serve", () => {
    expect(faultsFor("mock")).toEqual(MOCK_FAULTS);
    expect(MOCK_FAULTS).not.toContain("local_date_shift");
  });

  it("relabeled_status shows In Transit under its other name, and nothing else changes", () => {
    expect(relabeled("In Transit", on("relabeled_status"))).toBe("Rolling");
    expect(relabeled("Delivered", on("relabeled_status"))).toBe("Delivered");
    expect(relabeled("In Transit", NO_FAULTS)).toBe("In Transit");
  });

  it("stale_list_rows shows the older status and time, only while switched on", () => {
    const stale = { label: "Booked", at: "2026-11-03T14:00:00.000Z" };
    expect(faultedListRow(ROW, stale, on("stale_list_rows"))).toMatchObject({ statusLabel: "Booked", updatedAt: stale.at });
    expect(faultedListRow(ROW, stale, NO_FAULTS)).toEqual(ROW);
    expect(faultedListRow(ROW, null, on("stale_list_rows"))).toEqual(ROW);
  });

  it("clock_skew puts a delivery's UTC clock two days early and keeps its local clock", () => {
    const [h] = faultedHistory([DELIVERED], on("clock_skew"));
    expect(h.at).toEqual({ utc: "2026-11-01T19:45:00.000Z", local: "2026-11-03T13:45" });
    expect(faultedHistory([DELIVERED], NO_FAULTS)).toEqual([DELIVERED]);
  });

  it("hard_delete picks the lowest reference in transit, compared whole", () => {
    expect(deletedReference(["ML10", "ML9", "ML2"], on("hard_delete"))).toBe("ML10");
    expect(deletedReference(["ML2"], NO_FAULTS)).toBeNull();
    expect(deletedReference([], on("hard_delete"))).toBeNull();
  });
});
