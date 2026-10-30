import { describe, expect, it } from "vitest";
import { compareFactoringLines, factoringFor, factoringLineOf, type FactoringInput } from "./factoring";
import { c } from "./test-records";
import type { InvoiceRecord, PaymentApplicationRecord } from "./types";

// One invoice sold to the factoring partner, in integer cents: advance = balance x advance rate,
// fee = balance x fee rate, net = advance - fee, reserve = balance - advance. Pure: fixed dates,
// no clock, no I/O.

const AS_OF = "2026-11-02";
const RATES = { factoringAdvanceBps: 9000, factoringFeeBps: 300 };
const LIMITS = { maxAgeDays: 45, maxInvoices: 3 };
const PERIOD = { id: "per-open" };

function invoice(over: Partial<InvoiceRecord> & { id: string }): InvoiceRecord {
  return {
    customerId: "cust-1",
    source: "load",
    loadId: `load-${over.id}`,
    invoiceNumber: `INV-${over.id}`,
    amountCents: c(100_000),
    issuedOn: "2026-10-20",
    dueOn: "2026-11-19",
    status: "open",
    paidOn: null,
    qboId: null,
    ...over,
  };
}

const applied = (id: string, invoiceId: string, amount: number): PaymentApplicationRecord => ({
  id,
  paymentId: `pay-${id}`,
  invoiceId,
  amountCents: c(amount),
});

function input(over: Partial<FactoringInput> = {}): FactoringInput {
  return {
    invoices: [
      invoice({ id: "A", amountCents: c(215_000) }),
      invoice({ id: "B", amountCents: c(60_005), customerId: "cust-2" }),
      invoice({ id: "C", amountCents: c(100_000), status: "partially_paid" }),
      invoice({ id: "D", amountCents: c(50_000), status: "paid" }),
      invoice({ id: "E", amountCents: c(50_000), source: "opening", loadId: null }),
      invoice({ id: "F", amountCents: c(50_000), factored: true }),
      invoice({ id: "G", amountCents: c(50_000), issuedOn: "2026-09-17" }),
      invoice({ id: "H", amountCents: c(50_000), issuedOn: "2026-11-03" }),
      invoice({ id: "I", amountCents: c(30_000), status: "partially_paid" }),
      invoice({ id: "J", amountCents: c(1) }),
    ],
    applications: [applied("c1", "C", 40_000), applied("c2", "C", 10_000), applied("i1", "I", 30_000)],
    rates: RATES,
    period: PERIOD,
    ...over,
  };
}

const decide = (ids: string[], over: Partial<FactoringInput> = {}, short = 100_000) =>
  factoringFor(input(over), ids, AS_OF, LIMITS, short);

describe("factoringLineOf", () => {
  it("prices one invoice to the cent, rounding each rate half up", () => {
    const line = factoringLineOf({ id: "B", invoiceNumber: "INV-B", customerId: "cust-2" }, c(60_005), RATES);
    // 60,005 x 0.90 = 54,004.5 rounds to 54,005; 60,005 x 0.03 = 1,800.15 rounds to 1,800.
    expect(line).toEqual({
      invoiceId: "B",
      invoiceNumber: "INV-B",
      customerId: "cust-2",
      balanceCents: 60_005,
      advanceCents: 54_005,
      feeCents: 1_800,
      netCents: 52_205,
      reserveCents: 6_000,
    });
    expect(line.advanceCents - line.feeCents).toBe(line.netCents);
    expect(line.advanceCents + line.reserveCents).toBe(line.balanceCents);
  });
});

describe("compareFactoringLines", () => {
  it("puts the largest balance first, then the invoice number, then the id", () => {
    const line = (id: string, number: string, balance: number) =>
      factoringLineOf({ id, invoiceNumber: number, customerId: "c" }, c(balance), RATES);
    const sorted = [line("z", "INV-2", 100), line("y", "INV-1", 100), line("x", "INV-1", 100), line("w", "INV-9", 500)].sort(
      compareFactoringLines,
    );
    expect(sorted.map((l) => l.invoiceId)).toEqual(["w", "x", "y", "z"]);
  });
});

describe("factoringFor", () => {
  it("prices exactly the invoices named, largest first, with totals that are the lines' own sums", () => {
    const d = decide(["B", "A"]);
    if (!d.ok) throw new Error(d.category);
    const o = d.option;
    expect(o.invoices.map((l) => l.invoiceId)).toEqual(["A", "B"]);
    expect(o).toMatchObject({
      kind: "factoring_request",
      subjectTable: "settlement_periods",
      subjectId: PERIOD.id,
      direction: "in",
      advanceBps: 9000,
      feeBps: 300,
      balanceCents: 275_005,
      advanceCents: 193_500 + 54_005,
      feeCents: 6_450 + 1_800,
      amountCents: 187_050 + 52_205,
      reserveCents: 21_500 + 6_000,
      coversShort: true,
    });
    expect(o.amountCents).toBe(o.advanceCents - o.feeCents);
    expect(o.sources).toEqual([
      { table: "settlement_periods", id: PERIOD.id },
      { table: "invoices", id: "A" },
      { table: "customers", id: "cust-1" },
      { table: "invoices", id: "B" },
      { table: "customers", id: "cust-2" },
    ]);
  });

  it("prices a partly paid invoice at its balance after every payment applied to it", () => {
    const d = decide(["C"]);
    if (!d.ok) throw new Error(d.category);
    expect(d.option.invoices[0]).toMatchObject({ balanceCents: 50_000, advanceCents: 45_000, feeCents: 1_500, netCents: 43_500 });
  });

  it("says whether the net covers the short, with the short itself covered exactly", () => {
    const one = decide(["C"], {}, 43_500);
    const over = decide(["C"], {}, 43_501);
    if (!one.ok || !over.ok) throw new Error("refused");
    expect(one.option.coversShort).toBe(true);
    expect(over.option.coversShort).toBe(false);
  });

  it("refuses each invoice it may not sell, naming the invoice", () => {
    const cases: [string, string][] = [
      ["D", "invoice_not_open"],
      ["E", "invoice_not_from_load"],
      ["F", "invoice_already_factored"],
      ["G", "invoice_too_old"],
      ["H", "invoice_too_old"],
      ["I", "invoice_no_balance"],
      ["nope", "invoice_not_found"],
    ];
    for (const [id, category] of cases) expect(decide([id]), id).toEqual({ ok: false, category, invoiceId: id });
  });

  it("refuses a void invoice as not open", () => {
    expect(decide(["V"], { invoices: [invoice({ id: "V", status: "void" })] })).toEqual({
      ok: false,
      category: "invoice_not_open",
      invoiceId: "V",
    });
  });

  it("takes an invoice issued on the oldest allowed day and one issued today", () => {
    const edge = [invoice({ id: "old", issuedOn: "2026-09-18" }), invoice({ id: "new", issuedOn: AS_OF })];
    const d = decide(["old", "new"], { invoices: edge });
    expect(d.ok).toBe(true);
  });

  it("refuses an empty list, too many invoices and the same invoice twice", () => {
    expect(decide([])).toEqual({ ok: false, category: "no_invoices", invoiceId: null });
    expect(decide(["A", "B", "C", "J"])).toEqual({ ok: false, category: "too_many_invoices", invoiceId: null });
    expect(decide(["A", "A"])).toEqual({ ok: false, category: "duplicate_invoice", invoiceId: null });
  });

  it("refuses without the carrier's factoring rates", () => {
    expect(decide(["A"], { rates: null })).toEqual({ ok: false, category: "rates_missing", invoiceId: null });
  });

  it("refuses an invoice that would bring in nothing after the fee", () => {
    // 1 cent: the advance rounds to 1 and the fee to 0, so it nets 1; at a fee equal to the advance it nets 0.
    expect(decide(["J"]).ok).toBe(true);
    expect(decide(["J"], { rates: { factoringAdvanceBps: 9000, factoringFeeBps: 9000 } })).toEqual({
      ok: false,
      category: "no_net",
      invoiceId: null,
    });
  });

  it("gives the same answer for the same records, whatever order the invoices are named in", () => {
    expect(decide(["A", "B", "C"])).toEqual(decide(["C", "A", "B"]));
  });

  it("refuses a date that is not a real day", () => {
    expect(() => factoringFor(input(), ["A"], "2026-13-01", LIMITS, 1)).toThrow();
  });
});
