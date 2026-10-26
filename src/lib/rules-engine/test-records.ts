import { cents } from "./money";
import type {
  AdvanceRecord,
  Cents,
  DriverDayRecord,
  DriverRecord,
  LoadRecord,
  PayConfig,
  PayItemRecord,
  ScheduleRecord,
} from "./types";

// Test-only builders for hand-made records. Every name and number is invented. The two configs
// are the demo carriers' settings from the design table.

export const c = (n: number): Cents => cents(n);

export const BLUE_RIDGE: PayConfig = {
  weekStartDow: 1,
  percentBase: "linehaul",
  emptyMilesPaidBps: 0,
  accessorialDriverShareBps: 10_000,
  insuranceAppliesTo: "owner_operator",
  insurancePerDayCents: c(1_100),
  escrowTargetCents: c(200_000),
  escrowPerSettlementCents: c(10_000),
  netPayFloorCents: c(30_000),
  advanceRecoveryCapCents: null,
  advanceFeeCents: c(0),
  advanceLimitDefaultCents: c(50_000),
  advanceMaxBpsOfEarned: 5_000,
  advanceMinCents: c(5_000),
};

export const PRAIRIE_WIND: PayConfig = {
  weekStartDow: 0,
  percentBase: "linehaul_fsc",
  emptyMilesPaidBps: 10_000,
  accessorialDriverShareBps: 5_000,
  insuranceAppliesTo: "all",
  insurancePerDayCents: c(900),
  escrowTargetCents: c(150_000),
  escrowPerSettlementCents: c(7_500),
  netPayFloorCents: c(25_000),
  advanceRecoveryCapCents: c(25_000),
  advanceFeeCents: c(500),
  advanceLimitDefaultCents: c(75_000),
  advanceMaxBpsOfEarned: 6_000,
  advanceMinCents: c(5_000),
};

export const DRIVER_ID = "drv-1";

export function driver(over: Partial<DriverRecord> = {}): DriverRecord {
  return {
    id: DRIVER_ID,
    code: "T-D01",
    firstName: "Avery",
    lastName: "Quillfeather",
    email: "t-d01@test.example",
    workerType: "owner_operator",
    payBasis: "percent",
    perMileCents: null,
    percentBps: 7_500,
    flatPerLoadCents: null,
    advanceLimitCents: null,
    escrowBalanceCents: c(0),
    truckUnit: "T-101",
    activeFrom: "2026-01-05",
    activeTo: null,
    ...over,
  };
}

export function companyDriver(over: Partial<DriverRecord> = {}): DriverRecord {
  return driver({
    workerType: "company",
    payBasis: "per_mile",
    perMileCents: c(62),
    percentBps: null,
    ...over,
  });
}

// A delivered load with one state-mile row that matches its miles, unless the test says otherwise.
export function load(over: Partial<LoadRecord> & { id: string }): LoadRecord {
  const base: LoadRecord = {
    loadNumber: `L-${over.id}`,
    customerId: "cust-1",
    driverId: DRIVER_ID,
    status: "delivered",
    originCity: "Testville",
    originState: "VA",
    destCity: "Sampleton",
    destState: "GA",
    pickupOn: "2026-10-27",
    deliveredOn: "2026-10-28",
    deliveredAt: null,
    loadedMiles: 500,
    emptyMiles: 0,
    linehaulCents: c(100_000),
    fuelSurchargeCents: c(0),
    stateMiles: [],
    accessorials: [],
    ...over,
  };
  const stateMiles = over.stateMiles ?? [
    { id: `${over.id}-sm1`, state: "VA", miles: base.loadedMiles + base.emptyMiles },
  ];
  return { ...base, stateMiles };
}

export function day(
  id: string,
  date: string,
  over: Partial<DriverDayRecord> = {},
): DriverDayRecord {
  return { id, driverId: DRIVER_ID, day: date, source: "load", loadId: null, ...over };
}

export function item(over: Partial<PayItemRecord> & { id: string }): PayItemRecord {
  return {
    driverId: DRIVER_ID,
    kind: "reimbursement",
    subkind: null,
    amountCents: c(1_000),
    itemDate: "2026-10-28",
    refTable: null,
    refId: null,
    itemRef: `ref-${over.id}`,
    description: null,
    settlementId: null,
    ...over,
  };
}

export function schedule(over: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  return {
    driverId: DRIVER_ID,
    kind: "escrow",
    amountCents: c(10_000),
    targetCents: null,
    description: null,
    activeFrom: "2026-01-05",
    activeTo: null,
    ...over,
  };
}

export function advance(over: Partial<AdvanceRecord> & { id: string }): AdvanceRecord {
  return {
    driverId: DRIVER_ID,
    requestRef: `req-${over.id}`,
    requestedAt: "2026-10-28T15:00:00Z",
    requestedOn: "2026-10-28",
    amountCents: c(20_000),
    feeCents: c(0),
    status: "paid",
    recoveredCents: c(0),
    source: "seed",
    reasonCategory: null,
    paidAt: "2026-10-28T16:00:00Z",
    ...over,
  };
}
