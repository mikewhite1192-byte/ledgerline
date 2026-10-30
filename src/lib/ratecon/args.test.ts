import { describe, expect, it } from "vitest";
import { linesOf } from "../proposals/executors/load-create";
import { parseLoadCreateArgs, type LoadCreateArgs } from "./args";
import { RATECON_TOTAL_CENTS } from "./test-fixtures";

// The stored args of a load_create card: ids, codes, dates, counts and whole cents, nothing else.

const ARGS: LoadCreateArgs = {
  v: 1,
  loadId: "10000000-0000-4000-8000-000000000001",
  documentId: "20000000-0000-4000-8000-000000000001",
  inputId: "30000000-0000-4000-8000-000000000001",
  readingHash: "a".repeat(64),
  loadNumber: "RC-1001",
  customerId: "c0000000-0000-4000-8000-000000000001",
  customerCode: "CUST-1",
  originCity: "Dallas",
  originState: "TX",
  destCity: "Memphis",
  destState: "TN",
  pickupOn: "2026-11-05",
  deliveryOn: "2026-11-06",
  loadedMiles: 450,
  ratePerMileCents: 300,
  linehaulCents: 135_000,
  fuelSurchargeCents: 12_000,
  accessorials: [
    { kind: "stop", amountCents: 7_500 },
    { kind: "lumper", amountCents: 5_000 },
  ],
  totalCents: RATECON_TOTAL_CENTS,
  driverCodeClaim: "DRV-1",
};

describe("parseLoadCreateArgs", () => {
  it("parses the args a card stores, with or without its revision", () => {
    expect(parseLoadCreateArgs(ARGS)).toEqual(ARGS);
    expect(parseLoadCreateArgs({ ...ARGS, revision: 2 })).toEqual({ ...ARGS, revision: 2 });
    expect(parseLoadCreateArgs({ ...ARGS, deliveryOn: null, ratePerMileCents: null, driverCodeClaim: null })).not.toBeNull();
  });

  it("refuses an extra key, a missing key, or another version", () => {
    expect(parseLoadCreateArgs({ ...ARGS, note: "x" })).toBeNull();
    const { totalCents: _drop, ...missing } = ARGS;
    expect(parseLoadCreateArgs(missing)).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, v: 2 })).toBeNull();
    expect(parseLoadCreateArgs(null)).toBeNull();
  });

  it("refuses money that is not whole cents in range", () => {
    expect(parseLoadCreateArgs({ ...ARGS, totalCents: 1595.5 })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, totalCents: "159500" })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, linehaulCents: 0 })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, fuelSurchargeCents: -1 })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, totalCents: 1_000_000_000 })).toBeNull();
  });

  it("refuses a charge line with words, a fifth kind, or too many lines", () => {
    expect(parseLoadCreateArgs({ ...ARGS, accessorials: [{ kind: "stop", amountCents: 1, description: "x" }] })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, accessorials: [{ kind: "other", amountCents: 1 }] })).toBeNull();
    expect(parseLoadCreateArgs({ ...ARGS, accessorials: [{ kind: "stop", amountCents: 0 }] })).toBeNull();
    const seven = Array.from({ length: 7 }, () => ({ kind: "stop", amountCents: 1 }));
    expect(parseLoadCreateArgs({ ...ARGS, accessorials: seven })).toBeNull();
  });

  it("refuses ids, codes, places and dates off their patterns", () => {
    for (const edit of [
      { loadId: "not-a-uuid" },
      { readingHash: "A".repeat(64) },
      { loadNumber: "rc-1001" },
      { customerCode: "C" },
      { originState: "Texas" },
      { destCity: "9th Street" },
      { pickupOn: "11/05/2026" },
      { deliveryOn: "2026-02-30" },
      { loadedMiles: 0 },
      { loadedMiles: 10_000 },
      { driverCodeClaim: "drv 1" },
    ]) {
      expect(parseLoadCreateArgs({ ...ARGS, ...edit }), JSON.stringify(edit)).toBeNull();
    }
  });
});

describe("linesOf", () => {
  it("numbers each kind's lines from one, in the card's order", () => {
    expect(
      linesOf([
        { kind: "stop", amountCents: 100 },
        { kind: "lumper", amountCents: 200 },
        { kind: "stop", amountCents: 300 },
      ]),
    ).toEqual([
      { kind: "stop", seq: 1, amountCents: 100 },
      { kind: "lumper", seq: 1, amountCents: 200 },
      { kind: "stop", seq: 2, amountCents: 300 },
    ]);
  });
});
