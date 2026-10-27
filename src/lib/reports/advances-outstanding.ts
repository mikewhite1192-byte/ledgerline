import {
  advanceLimitOf,
  compareText,
  outstandingCents,
  sub,
  sum,
  type AdvanceRecord,
  type DriverRecord,
  type PayConfig,
} from "../rules-engine";
import { byId, byLargest, driverCell, mustGet, reportOf } from "./build";
import type { ReportResult, ReportRow } from "./types";

// What each driver still owes on advances: the engine's outstandingCents (approved or paid
// advances, amount + fee less what was taken back), summed per driver, next to the engine's
// advance limit and the room left under it.

export type AdvancesOutstandingInput = {
  advances: readonly AdvanceRecord[];
  drivers: readonly DriverRecord[];
  // The pay rules in force on asOf; null when no version covers that day yet.
  config: PayConfig | null;
};

export function computeAdvancesOutstanding(input: AdvancesOutstandingInput, asOf: string): ReportResult {
  const drivers = byId(input.drivers, "drivers");
  const open = new Map<string, AdvanceRecord[]>();
  for (const a of input.advances) {
    if (a.requestedOn > asOf || outstandingCents(a) <= 0) continue;
    const list = open.get(a.driverId) ?? [];
    list.push(a);
    open.set(a.driverId, list);
  }
  const rows: ReportRow[] = [];
  let count = 0;
  const owed: number[] = [];
  for (const [driverId, list] of open) {
    const driver = mustGet(drivers, driverId, "driver");
    const outstanding = sum(list.map((a) => outstandingCents(a)));
    const oldest = list.map((a) => a.requestedOn).sort(compareText)[0];
    const limit = input.config ? advanceLimitOf(input.config, driver) : null;
    rows.push({
      driver: driverCell(driver),
      advances: list.length,
      outstandingCents: outstanding,
      oldestRequestedOn: oldest,
      limitCents: limit,
      headroomCents: limit === null ? null : sub(limit, outstanding),
    });
    count += list.length;
    owed.push(outstanding);
  }
  rows.sort(byLargest("outstandingCents", "driver"));
  return reportOf("advances_outstanding", {
    asOf,
    args: { asOf },
    rows,
    totals: { advances: count, outstandingCents: sum(owed) },
  });
}
