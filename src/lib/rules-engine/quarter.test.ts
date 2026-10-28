import { describe, expect, it } from "vitest";
import { findUnbilledDetention } from "./detention";
import type { ProfitLine } from "./profit";
import { fixWords, QUARTER_DRIVERS, quarterOf, type QuarterInput } from "./quarter";
import { c } from "./test-records";
import { InputError, type InvoiceRecord, type SettlementRecord } from "./types";

// The quarter review's engine: the calendar quarter so far from its pay runs, invoices, payments,
// the agent's fixes and the detention it found, every figure whole cents or a whole count, and the
// numbered figure list the review may cite. Every name and number is invented.

const QUARTER = { start: "2026-10-01", end: "2026-12-31" };
const AS_OF = "2026-11-02";
const ROUTE = { originCity: "Roanoke", originState: "VA", destCity: "Charlotte", destState: "NC" };

function stub(id: string, periodId: string, driverId: string, net: number, exceptionCount = 0): SettlementRecord {
  return {
    id,
    periodId,
    driverId,
    status: "paid",
    grossCents: c(net + 20_000),
    deductionsCents: c(20_000),
    netCents: c(net),
    carryForwardCents: c(0),
    exceptionCount,
    paidAt: null,
  };
}

function invoice(
  id: string,
  customerId: string,
  amount: number,
  issuedOn: string,
  status: InvoiceRecord["status"],
  dueOn = "2026-11-30",
): InvoiceRecord {
  return {
    id,
    source: "load",
    loadId: `load-${id}`,
    customerId,
    invoiceNumber: `INV-${id}`,
    amountCents: c(amount),
    issuedOn,
    dueOn,
    status,
    paidOn: status === "paid" ? "2026-10-20" : null,
    qboId: null,
  };
}

function priced(loadId: string, revenue: number | null, pay: number | null): ProfitLine {
  return {
    loadId,
    loadNumber: `L-${loadId}`,
    customerId: "cust-a",
    customerName: "Acme Freight",
    lane: ROUTE,
    loadedMiles: 300,
    revenueCents: revenue,
    driverPayCents: pay,
    marginCents: revenue !== null && pay !== null ? revenue - pay : null,
    note: null,
  };
}

const customer = (id: string, name: string) => ({
  id,
  code: id.toUpperCase(),
  name,
  termsDays: 30,
  city: "Roanoke",
  state: "VA",
  detentionFreeMinutes: 120,
  detentionHourlyCents: c(6_000),
});

function input(over: Partial<QuarterInput> = {}): QuarterInput {
  return {
    periods: [
      // Ends in the last quarter: not this quarter's.
      { id: "p0", periodStart: "2026-09-21", periodEnd: "2026-09-27", status: "paid" },
      // Starts in the last quarter but ends in this one: this quarter's.
      { id: "p1", periodStart: "2026-09-28", periodEnd: "2026-10-04", status: "paid" },
      { id: "p2", periodStart: "2026-10-05", periodEnd: "2026-10-11", status: "approved" },
      { id: "p3", periodStart: "2026-10-26", periodEnd: "2026-11-01", status: "open" },
      // Starts after asOf: not here yet.
      { id: "p4", periodStart: "2026-11-09", periodEnd: "2026-11-15", status: "open" },
    ],
    settlements: [
      stub("s0", "p0", "drv-a", 99_999),
      stub("s1", "p1", "drv-a", 150_000),
      stub("s2", "p1", "drv-b", 120_000, 2),
      stub("s3", "p2", "drv-a", 140_000, 1),
      stub("s4", "p3", "drv-b", 80_000, 3),
    ],
    lines: [
      { settlementId: "s1", kind: "advance_recovery", amountCents: -5_000 },
      { settlementId: "s3", kind: "advance_recovery", amountCents: -2_500 },
      // On the open run: still changing, so not counted.
      { settlementId: "s4", kind: "advance_recovery", amountCents: -7_000 },
      // On last quarter's run.
      { settlementId: "s0", kind: "advance_recovery", amountCents: -9_000 },
      { settlementId: "s1", kind: "linehaul", amountCents: 150_000 },
    ],
    drivers: [
      { id: "drv-a", name: "Avery Lane" },
      { id: "drv-b", name: "Blake Moss" },
    ],
    customers: [customer("cust-a", "Acme Freight"), customer("cust-b", "Birch Supply")],
    margin: [priced("l1", 300_000, 200_000), priced("l2", 100_000, 90_000), priced("l3", null, 50_000)],
    receivables: {
      invoices: [
        invoice("i1", "cust-a", 300_000, "2026-10-06", "paid"),
        invoice("i2", "cust-a", 100_000, "2026-10-20", "open"),
        invoice("i3", "cust-b", 80_000, "2026-09-15", "open", "2026-10-15"),
        invoice("i4", "cust-b", 50_000, "2026-10-21", "void"),
      ],
      payments: [
        {
          id: "pay1",
          customerId: "cust-a",
          receivedOn: "2026-10-20",
          amountCents: c(300_000),
          method: "ach",
          paymentRef: "ACH-1",
          source: "seed",
          memo: null,
          qboId: null,
        },
        {
          id: "pay0",
          customerId: "cust-b",
          receivedOn: "2026-09-25",
          amountCents: c(10_000),
          method: "check",
          paymentRef: "CHK-1",
          source: "seed",
          memo: null,
          qboId: null,
        },
      ],
      applications: [{ id: "app1", paymentId: "pay1", invoiceId: "i1", amountCents: c(300_000) }],
      asOf: AS_OF,
    },
    loads: [],
    accessorials: [],
    proposals: [
      { id: "x1", kind: "pay_correction", status: "done", direction: "in", amountCents: 2_000, createdOn: "2026-10-10", decidedOn: "2026-10-11" },
      // Money paid out to a driver is a correction, not a recovery.
      { id: "x2", kind: "pay_correction", status: "done", direction: "out", amountCents: 4_000, createdOn: "2026-10-12", decidedOn: "2026-10-12" },
      // Not done yet.
      { id: "x3", kind: "pay_correction", status: "approved", direction: "in", amountCents: 8_000, createdOn: "2026-10-13", decidedOn: "2026-10-13" },
      // Decided before the quarter began.
      { id: "x4", kind: "pay_correction", status: "done", direction: "in", amountCents: 16_000, createdOn: "2026-09-20", decidedOn: "2026-09-21" },
      { id: "x5", kind: "detention_charge", status: "done", direction: "in", amountCents: 3_000, createdOn: "2026-10-14", decidedOn: "2026-10-15" },
      { id: "x6", kind: "detention_charge", status: "rejected", direction: "in", amountCents: 6_000, createdOn: "2026-10-16", decidedOn: "2026-10-16" },
      { id: "x7", kind: "invoice_fix", status: "failed", direction: "in", amountCents: 0, createdOn: "2026-10-18", decidedOn: "2026-10-18" },
      { id: "x8", kind: "made_up_kind", status: "expired", direction: "in", amountCents: 700, createdOn: "2026-10-19", decidedOn: null },
    ],
    detention: [
      { id: "d1", loadId: "l1", amountCents: 3_000, proposalId: "x5", proposalStatus: "done", decidedOn: "2026-10-15" },
      { id: "d2", loadId: "l2", amountCents: 6_000, proposalId: "x6", proposalStatus: "rejected", decidedOn: "2026-10-16" },
      // Done, but before the quarter.
      { id: "d3", loadId: "l3", amountCents: 9_000, proposalId: "x9", proposalStatus: "done", decidedOn: "2026-09-30" },
    ],
    ...over,
  };
}

describe("quarterOf", () => {
  it("counts the pay runs whose last day falls in the quarter so far, and sums only the closed ones", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.window).toEqual({ start: "2026-10-01", end: "2026-11-02" });
    expect(q.payRuns.map((r) => r.periodId)).toEqual(["p1", "p2", "p3"]);
    expect(q.pay).toEqual({
      runs: 3,
      paid: 1,
      approved: 1,
      open: 1,
      paystubs: 3,
      drivers: 2,
      grossCents: 470_000,
      deductionsCents: 60_000,
      netCents: 410_000,
      exceptionCount: 3,
      withProblem: 2,
    });
    // The open run still lists its own paystub and problems.
    expect(q.payRuns[2]).toMatchObject({ paystubs: 1, netCents: 80_000, exceptionCount: 3, withProblem: 1 });
  });

  it("money recovered counts only detention rows whose proposal is done and decided in the quarter", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.recovered.detentionCount).toBe(1);
    expect(q.recovered.detentionCents).toBe(3_000);
  });

  it("a pay correction counts as recovered only when done, inside the quarter, and money coming back in", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.recovered.correctionsCount).toBe(1);
    expect(q.recovered.correctionsCents).toBe(2_000);
  });

  it("advances recovered are the size of the recovery deductions on closed runs, written above zero", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.recovered.advancesCents).toBe(7_500);
    expect(q.recovered.totalCents).toBe(3_000 + 2_000 + 7_500);
  });

  it("invoices issued and payments received count only the quarter so far, and a void invoice never", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.invoiced).toEqual({ count: 2, cents: 400_000 });
    expect(q.received).toEqual({ count: 1, cents: 300_000 });
    // What is owed is as of the day asked, whenever it was billed; a payment not applied to an
    // invoice does not lower it.
    expect(q.receivables).toEqual({ openCents: 180_000, pastDueCents: 80_000 });
  });

  it("sorts the agent's fixes by status and by kind, with a kind it does not know as other fixes", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    // x4 was made before the quarter began.
    expect(q.exceptions).toMatchObject({ suggested: 7, done: 3, waiting: 1, declined: 2, failed: 1 });
    expect(q.exceptions.byKind).toEqual([
      { kind: "pay_correction", label: "Pay corrections", count: 3, amountCents: 14_000 },
      { kind: "detention_charge", label: "Detention charges", count: 2, amountCents: 9_000 },
      { kind: "invoice_fix", label: "Invoice fixes", count: 1, amountCents: 0 },
      { kind: "other", label: "Other fixes", count: 1, amountCents: 700 },
    ]);
    expect(fixWords("toString")).toBe("Other fixes");
  });

  it("counts the detention not billed with the detention check's own code", () => {
    const loads = [
      {
        id: "l9",
        loadNumber: "L-9",
        customerId: "cust-a",
        deliveredOn: "2026-10-22",
        pickupArrivedAt: "2026-10-22T12:00:00.000Z",
        pickupDepartedAt: "2026-10-22T16:00:00.000Z",
        deliveryArrivedAt: "2026-10-22T20:00:00.000Z",
        deliveryDepartedAt: "2026-10-22T21:00:00.000Z",
      },
    ];
    const data = input({ loads });
    const q = quarterOf(data, QUARTER, AS_OF);
    const expected = findUnbilledDetention(loads, data.customers, [], q.window);
    expect(expected).toHaveLength(1);
    expect(q.exceptions.unbilledLoads).toBe(1);
    expect(q.exceptions.unbilledCents).toBe(expected[0].amountCents);
    expect(q.exceptions.unbilledCents).toBeGreaterThan(0);
  });

  it("prices the margin with the profit report's code, keeping unpriced loads out of the sums", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.margin).toEqual({
      loads: 2,
      loadsDelivered: 3,
      revenueCents: 400_000,
      driverPayCents: 290_000,
      marginCents: 110_000,
      marginBps: 2_750,
    });
  });

  it("refuses a day outside the quarter, receivables as of another day, a bad date, and a part count", () => {
    expect(() => quarterOf(input(), QUARTER, "2027-01-01")).toThrow(InputError);
    expect(() => quarterOf(input(), QUARTER, "2026-09-30")).toThrow(InputError);
    const other = input();
    expect(() => quarterOf({ ...other, receivables: { ...other.receivables, asOf: "2026-11-01" } }, QUARTER, AS_OF)).toThrow(
      /not as of asOf/,
    );
    expect(() => quarterOf(input(), { start: "2026-10-1", end: QUARTER.end }, AS_OF)).toThrow(InputError);
    const part = input({ settlements: [stub("s1", "p1", "drv-a", 150_000, 1.5)] });
    expect(() => quarterOf(part, QUARTER, AS_OF)).toThrow(/not a whole number/);
  });
});

describe("quarterFigures", () => {
  it("numbers the figures f1 up in order, headline first, with no digit in any label", () => {
    const q = quarterOf(input(), QUARTER, AS_OF);
    expect(q.figures.map((f) => f.key)).toEqual(q.figures.map((_, i) => `f${i + 1}`));
    expect(q.figures[0]).toMatchObject({ label: "Pay runs so far", kind: "int", value: 3, source: { section: "pay_runs" } });
    for (const f of q.figures) {
      expect(f.label, f.key).not.toMatch(/\d/);
      expect(Number.isSafeInteger(f.value), f.key).toBe(true);
    }
    const value = (label: string) => q.figures.find((f) => f.label === label)?.value;
    expect(value("Money recovered")).toBe(12_500);
    expect(value("Advances recovered from pay")).toBe(7_500);
    expect(value("Margin as a share of revenue")).toBe(2_750);
    expect(value("Fixes that failed")).toBe(1);
    expect(value("Pay runs approved, not paid yet")).toBe(1);
    expect(q.figures.find((f) => f.label === "Revenue from priced loads")?.source).toEqual({
      report: "margin_per_load",
      args: { periodStart: "2026-10-01", periodEnd: "2026-11-02" },
    });
    expect(q.figures.find((f) => f.label === "Open receivables")?.source).toEqual({ report: "ar_aging", args: { asOf: AS_OF } });
    // A customer's figures link to the customer and carry its name as the subject.
    const acme = q.figures.filter((f) => f.subject === "Acme Freight");
    expect(acme.map((f) => f.label)).toEqual([
      "Customer Acme Freight: invoiced",
      "Customer Acme Freight: payments received",
      "Customer Acme Freight: open balance",
      "Customer Acme Freight: average days to pay",
    ]);
    expect(acme.every((f) => "table" in f.source && f.source.table === "customers" && f.source.id === "cust-a")).toBe(true);
  });

  it("leaves out a figure that would only say none: no approved run, no failed fix, no margin share without revenue", () => {
    const q = quarterOf(
      input({
        periods: [{ id: "p1", periodStart: "2026-09-28", periodEnd: "2026-10-04", status: "paid" }],
        margin: [priced("l3", null, 50_000)],
        proposals: [],
      }),
      QUARTER,
      AS_OF,
    );
    const labels = q.figures.map((f) => f.label);
    expect(labels).not.toContain("Pay runs approved, not paid yet");
    expect(labels).not.toContain("Fixes that failed");
    expect(labels).not.toContain("Margin as a share of revenue");
    expect(labels).toContain("Pay runs still open");
  });

  it("names the drivers with the most and the least net pay, each once", () => {
    const names = ["Ann", "Bea", "Cal", "Dee", "Eli", "Fay", "Gus"];
    const settlements = names.map((n, i) => stub(`s${i}`, "p1", `drv-${n}`, 100_000 + i * 1_000));
    const many = quarterOf(
      input({ settlements, lines: [], drivers: names.map((n) => ({ id: `drv-${n}`, name: n })) }),
      QUARTER,
      AS_OF,
    );
    const named = (q: typeof many) => q.figures.filter((f) => f.label.startsWith("Driver ") && f.label.endsWith("net pay")).map((f) => f.subject);
    expect(named(many)).toEqual(["Gus", "Fay", "Eli", "Ann", "Bea", "Cal"]);
    expect(many.figures.find((f) => f.subject === "Ann")?.label).toBe("Driver Ann (least net pay): net pay");

    const few = quarterOf(
      input({ settlements: settlements.slice(0, 4), lines: [], drivers: names.map((n) => ({ id: `drv-${n}`, name: n })) }),
      QUARTER,
      AS_OF,
    );
    expect(named(few)).toEqual(["Dee", "Cal", "Bea", "Ann"]);
    expect(named(few)).toHaveLength(QUARTER_DRIVERS + 1);
  });
});
