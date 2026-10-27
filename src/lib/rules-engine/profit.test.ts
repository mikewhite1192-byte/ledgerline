import { describe, expect, it } from "vitest";
import {
  marginBpsOf,
  profitFigures,
  profitTotals,
  rollupByCustomer,
  rollupByLane,
  routeOf,
  type ProfitLine,
} from "./profit";
import { daysToPay } from "./receivables";
import {
  InputError,
  type CustomerPaymentRecord,
  type InvoiceRecord,
  type PaymentApplicationRecord,
  type ReceivablesInput,
} from "./types";

// The profit brief's engine: roll-ups by route and by customer in integer cents, the margin in
// basis points, how long a customer takes to pay, and the numbered figures a brief may cite.

const ROANOKE = { originCity: "Roanoke", originState: "VA", destCity: "Charlotte", destState: "NC" };
const BACK = { originCity: "Charlotte", originState: "NC", destCity: "Roanoke", destState: "VA" };
const DAYTON = { originCity: "Dayton", originState: "OH", destCity: "Akron", destState: "OH" };

let n = 0;
function line(lane: ProfitLine["lane"], revenue: number | null, pay: number | null, more: Partial<ProfitLine> = {}): ProfitLine {
  n += 1;
  return {
    loadId: `load-${n}`,
    loadNumber: `L-${1000 + n}`,
    customerId: "cust-a",
    customerName: "Acme Freight",
    lane,
    loadedMiles: 300,
    revenueCents: revenue,
    driverPayCents: pay,
    marginCents: revenue !== null && pay !== null ? revenue - pay : null,
    note: revenue === null ? "No rate" : pay === null ? "No driver" : null,
    ...more,
  };
}

const LINES: ProfitLine[] = [
  line(ROANOKE, 200_000, 120_000),
  line(ROANOKE, 180_000, 110_000, { loadedMiles: 280 }),
  line(BACK, 150_000, 160_000, { customerId: "cust-b", customerName: "Blue Mill" }),
  line(DAYTON, 90_000, 40_000, { customerId: "cust-b", customerName: "Blue Mill" }),
  line(DAYTON, null, 30_000, { note: "No rate" }),
  line(ROANOKE, 70_000, null, { note: "No driver" }),
  line(DAYTON, 60_000, 20_000, { customerId: null, customerName: null }),
];

describe("profit roll-ups", () => {
  it("rollupByLane sums both directions separately and orders by margin", () => {
    const rows = rollupByLane(LINES);
    expect(rows.map((r) => [r.route, r.loads, r.revenueCents, r.driverPayCents, r.marginCents, r.marginBps])).toEqual([
      ["Roanoke, VA to Charlotte, NC", 2, 380_000, 230_000, 150_000, 3947],
      ["Dayton, OH to Akron, OH", 2, 150_000, 60_000, 90_000, 6000],
      ["Charlotte, NC to Roanoke, VA", 1, 150_000, 160_000, -10_000, -667],
    ]);
    // Revenue per loaded mile over the priced loads only: 380,000 cents / 580 miles.
    expect(rows[0].loadedMiles).toBe(580);
    expect(rows[0].centsPerLoadedMile).toBe(655);
    expect(routeOf(BACK)).toBe("Charlotte, NC to Roanoke, VA");
    expect(rollupByLane(LINES, 2).map((r) => r.route)).toEqual(rows.slice(0, 2).map((r) => r.route));
    // The same loads in another order roll up the same.
    expect(rollupByLane([...LINES].reverse())).toEqual(rows);
    expect(() => rollupByLane(LINES, 0)).toThrow(InputError);
  });

  it("totals only the priced loads, counts every delivered one, and leaves a load with no customer out of the customer rows", () => {
    expect(profitTotals(LINES)).toEqual({
      loads: 5,
      loadsDelivered: 7,
      revenueCents: 680_000,
      driverPayCents: 450_000,
      marginCents: 230_000,
      marginBps: 3382,
    });
    expect(rollupByCustomer(LINES).map((r) => [r.customerName, r.loads, r.marginCents])).toEqual([
      ["Acme Freight", 2, 150_000],
      ["Blue Mill", 2, 40_000],
    ]);
    expect(profitTotals([])).toEqual({
      loads: 0,
      loadsDelivered: 0,
      revenueCents: 0,
      driverPayCents: 0,
      marginCents: 0,
      marginBps: null,
    });
  });

  it("rounds a margin percent half up and keeps its sign", () => {
    expect(marginBpsOf(1, 3)).toBe(3333);
    expect(marginBpsOf(2, 3)).toBe(6667);
    expect(marginBpsOf(-2, 3)).toBe(-6667);
    expect(marginBpsOf(5, 0)).toBeNull();
  });
});

const AS_OF = "2026-10-25";
const invoice = (id: string, cents: number, issuedOn: string, more: Partial<InvoiceRecord> = {}): InvoiceRecord =>
  ({
    id,
    source: "load",
    loadId: `load-${id}`,
    customerId: "cust-a",
    invoiceNumber: `INV-${id}`,
    amountCents: cents,
    issuedOn,
    dueOn: issuedOn,
    status: "open",
    paidOn: null,
    qboId: null,
    ...more,
  }) as InvoiceRecord;
const payment = (id: string, cents: number, receivedOn: string): CustomerPaymentRecord =>
  ({
    id,
    customerId: "cust-a",
    receivedOn,
    amountCents: cents,
    method: "ach",
    paymentRef: `ACH-${id}`,
    source: "seed",
    memo: null,
    qboId: null,
  }) as CustomerPaymentRecord;
const apply = (id: string, paymentId: string, invoiceId: string, cents: number) =>
  ({ id, paymentId, invoiceId, amountCents: cents }) as PaymentApplicationRecord;

describe("daysToPay", () => {
  it("daysToPay uses the latest application date and ignores unpaid invoices", () => {
    const input: ReceivablesInput = {
      asOf: AS_OF,
      invoices: [
        // Paid in two parts: the second payment, 30 days after issue, is the paid date.
        invoice("i1", 100_000, "2026-09-01"),
        // Paid in one, 10 days after issue.
        invoice("i2", 50_000, "2026-09-10"),
        // Half paid: not paid, so not counted.
        invoice("i3", 80_000, "2026-09-05"),
        // Paid, but void.
        invoice("i4", 20_000, "2026-09-05", { status: "void" }),
        // Paid only by a payment that arrived after asOf: not paid as of then.
        invoice("i5", 30_000, "2026-10-01"),
        // Another customer's.
        invoice("i6", 30_000, "2026-09-01", { customerId: "cust-b" }),
      ],
      payments: [
        payment("p1", 60_000, "2026-09-11"),
        payment("p2", 40_000, "2026-10-01"),
        payment("p3", 50_000, "2026-09-20"),
        payment("p4", 40_000, "2026-09-20"),
        payment("p5", 20_000, "2026-09-06"),
        payment("p6", 30_000, "2026-10-30"),
        payment("p7", 30_000, "2026-09-02"),
      ],
      applications: [
        apply("a1", "p1", "i1", 60_000),
        apply("a2", "p2", "i1", 40_000),
        apply("a3", "p3", "i2", 50_000),
        apply("a4", "p4", "i3", 40_000),
        apply("a5", "p5", "i4", 20_000),
        apply("a6", "p6", "i5", 30_000),
        apply("a7", "p7", "i6", 30_000),
      ],
    };
    // i1: Sep 1 to Oct 1 is 30 days; i2: Sep 10 to Sep 20 is 10 days. Mean 20, median 20.
    expect(daysToPay("cust-a", input, AS_OF)).toEqual({ customerId: "cust-a", paidCount: 2, meanDays: 20, medianDays: 20 });
    // As of a day after the late payment, i5 is paid too (29 days): mean of 30, 10, 29 is 23.
    expect(daysToPay("cust-a", input, "2026-10-31")).toMatchObject({ paidCount: 3, meanDays: 23, medianDays: 29 });
    expect(daysToPay("cust-c", input, AS_OF)).toEqual({ customerId: "cust-c", paidCount: 0, meanDays: null, medianDays: null });
  });

  it("counts only invoices paid in the 180 days before the day asked", () => {
    const input: ReceivablesInput = {
      asOf: AS_OF,
      invoices: [invoice("old", 10_000, "2026-01-01"), invoice("new", 10_000, "2026-10-01")],
      payments: [payment("p1", 10_000, "2026-01-11"), payment("p2", 10_000, "2026-10-06")],
      applications: [apply("a1", "p1", "old", 10_000), apply("a2", "p2", "new", 10_000)],
    };
    expect(daysToPay("cust-a", input, AS_OF)).toMatchObject({ paidCount: 1, meanDays: 5 });
  });
});

describe("profitFigures", () => {
  const receivables: ReceivablesInput = { asOf: AS_OF, invoices: [], payments: [], applications: [] };
  const period = { start: "2026-10-19", end: "2026-10-25" };

  it("numbers the totals, then the routes and customers, each figure the engine's own value", () => {
    const figures = profitFigures(LINES, receivables, period, AS_OF, { maxLanes: 1, maxCustomers: 1 });
    expect(figures.map((f) => [f.key, f.label, f.kind, f.value])).toEqual([
      ["f1", "Revenue", "cents", 680_000],
      ["f2", "Driver pay", "cents", 450_000],
      ["f3", "Margin", "cents", 230_000],
      ["f4", "Margin percent", "bps", 3382],
      ["f5", "Loads priced", "int", 5],
      ["f6", "Loads delivered", "int", 7],
      ["f7", "Route Roanoke, VA to Charlotte, NC: loads", "int", 2],
      ["f8", "Route Roanoke, VA to Charlotte, NC: revenue", "cents", 380_000],
      ["f9", "Route Roanoke, VA to Charlotte, NC: margin", "cents", 150_000],
      ["f10", "Route Roanoke, VA to Charlotte, NC: margin percent", "bps", 3947],
      ["f11", "Route Roanoke, VA to Charlotte, NC: revenue per loaded mile", "cents", 655],
      ["f12", "Customer Acme Freight: loads", "int", 2],
      ["f13", "Customer Acme Freight: revenue", "cents", 380_000],
      ["f14", "Customer Acme Freight: margin", "cents", 150_000],
      ["f15", "Customer Acme Freight: margin percent", "bps", 3947],
    ]);
    expect(figures[11].source).toEqual({ table: "customers", id: "cust-a" });
    expect(figures[11].subject).toBe("Acme Freight");
    expect(figures[0].source).toEqual({ report: "margin_per_load", args: { periodStart: period.start, periodEnd: period.end } });
    expect(() => profitFigures(LINES, receivables, { start: "Oct 19", end: period.end }, AS_OF, { maxLanes: 1, maxCustomers: 1 })).toThrow(
      InputError,
    );
  });
});
