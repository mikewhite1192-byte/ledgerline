import { describe, expect, it } from "vitest";
import { invoiceAmount } from "./invoices";
import { c, load } from "./test-records";
import { InputError, type AccessorialRecord } from "./types";

const acc = (
  id: string,
  kind: AccessorialRecord["kind"],
  seq: number,
  amount: number,
  paidByDriver = false,
) => ({
  id,
  kind,
  seq,
  amountCents: c(amount),
  paidByDriver,
  description: null,
});

describe("invoiceAmount", () => {
  it("bills linehaul, fuel surcharge and every accessorial, lumper included", () => {
    const result = invoiceAmount(
      load({
        id: "l1",
        linehaulCents: c(100_000),
        fuelSurchargeCents: c(12_000),
        accessorials: [
          acc("s2", "stop", 2, 2_500),
          acc("lump", "lumper", 1, 17_500, true),
          acc("lay", "layover", 1, 0),
          acc("s1", "stop", 1, 2_500),
          acc("det", "detention", 1, 5_000),
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      amountCents: 139_500,
      sources: [{ table: "loads", id: "l1" }],
      lines: [
        { kind: "linehaul", amountCents: 100_000, sources: [{ table: "loads", id: "l1" }] },
        { kind: "fuel_surcharge", amountCents: 12_000, sources: [{ table: "loads", id: "l1" }] },
        {
          kind: "detention",
          amountCents: 5_000,
          sources: [{ table: "load_accessorials", id: "det" }],
        },
        {
          kind: "lumper",
          amountCents: 17_500,
          sources: [{ table: "load_accessorials", id: "lump" }],
        },
        { kind: "stop", amountCents: 2_500, sources: [{ table: "load_accessorials", id: "s1" }] },
        { kind: "stop", amountCents: 2_500, sources: [{ table: "load_accessorials", id: "s2" }] },
      ],
    });
  });

  it("bills linehaul alone when there is nothing else, and an invoiced load the same way", () => {
    const plain = invoiceAmount(load({ id: "l1", linehaulCents: c(85_000) }));
    expect(plain).toMatchObject({ ok: true, amountCents: 85_000 });
    expect(plain.ok && plain.lines.map((l) => l.kind)).toEqual(["linehaul"]);
    const invoiced = invoiceAmount(
      load({ id: "l1", status: "invoiced", linehaulCents: c(85_000) }),
    );
    expect(invoiced).toMatchObject({ ok: true, amountCents: 85_000 });
  });

  it.each([
    ["a load with no rate", load({ id: "l1", linehaulCents: null }), "missing_rate"],
    ["a load with no customer", load({ id: "l1", customerId: null }), "missing_customer"],
    [
      "a load with neither, naming the rate first",
      load({ id: "l1", linehaulCents: null, customerId: null }),
      "missing_rate",
    ],
    ["a planned load", load({ id: "l1", status: "planned", deliveredOn: null }), "not_delivered"],
    [
      "a load in transit",
      load({ id: "l1", status: "in_transit", deliveredOn: null }),
      "not_delivered",
    ],
    [
      "a cancelled load",
      load({ id: "l1", status: "cancelled", deliveredOn: null }),
      "not_delivered",
    ],
  ])("refuses %s", (_name, given, reason) => {
    expect(invoiceAmount(given)).toEqual({
      ok: false,
      reason,
      sources: [{ table: "loads", id: "l1" }],
    });
  });

  it("refuses a total the invoices table cannot hold, and a malformed load", () => {
    const huge = load({ id: "l1", linehaulCents: c(999_999_999), fuelSurchargeCents: c(1) });
    expect(() => invoiceAmount(huge)).toThrow(InputError);
    expect(() => invoiceAmount(load({ id: "l1", linehaulCents: c(-1) }))).toThrow(InputError);
    expect(() => invoiceAmount(load({ id: "l1", status: "billed" as never }))).toThrow(InputError);
  });
});
