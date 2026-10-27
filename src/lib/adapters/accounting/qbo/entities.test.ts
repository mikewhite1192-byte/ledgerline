import { describe, expect, it } from "vitest";
import { MoneyError } from "../../../money/types";
import {
  appliedAsAsked,
  billBody,
  billDocNumber,
  billKeyOf,
  billPaymentBody,
  customerDisplayName,
  invoiceBody,
  isVoided,
  paymentBody,
  purchaseBody,
  queryRows,
  recordOf,
  tenantCodeOf,
  vendorBody,
  vendorDisplayName,
} from "./entities";
import { ACCOUNTS, ITEMS, TENANT } from "./test-fakes";
import { bodyJson, decimalField, faultCodes } from "./wire";

const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
// TENANT's code and bill key.
const CODE = "T5B0E6F1A2C3D";
const KEY = "T5B0E";

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof MoneyError ? err.category : "other";
  }
  return "accepted";
};

describe("QuickBooks wire format", () => {
  it("writes amounts as exact decimals and refuses anything else", () => {
    expect(bodyJson({ a: decimalField("0.10"), b: decimalField("-12.34"), c: "0.10" })).toBe(
      '{"a":0.10,"b":-12.34,"c":"0.10"}',
    );
    for (const bad of ["1.5", "1", "1.234", "1e3", "12345678901.00", " 1.00"]) {
      expect(refused(() => decimalField(bad)), bad).toBe("validation");
    }
  });

  it("reads fault codes and type, ignoring anything out of shape", () => {
    expect(
      faultCodes({ Fault: { type: "ValidationFault", Error: [{ code: "6140", Message: "x" }, { code: 5 }] } }),
    ).toEqual({ type: "ValidationFault", codes: ["6140"] });
    expect(faultCodes({ Fault: { type: "bad type!", Error: [{ code: "has space" }] } })).toEqual({
      type: "",
      codes: [],
    });
    expect(faultCodes(null)).toEqual({ type: "", codes: [] });
  });
});

describe("QuickBooks bodies", () => {
  it("takes the tenant code and bill key from the tenant id, refusing a malformed id", () => {
    expect(tenantCodeOf(TENANT)).toBe(CODE);
    expect(billKeyOf(TENANT)).toBe(KEY);
    // Two tenants differ by id alone, whatever their slugs.
    const other = "5b0e6f1a-2c3e-4e5f-8a9b-0c1d2e3f4a5b";
    expect(tenantCodeOf(other)).toBe("T5B0E6F1A2C3E");
    expect(tenantCodeOf(other)).not.toBe(tenantCodeOf(TENANT));
    for (const bad of [TENANT.toUpperCase(), TENANT.replace(/-/g, ""), "blue-ridge", "", null, undefined, 5]) {
      expect(refused(() => tenantCodeOf(bad)), String(bad)).toBe("validation");
      expect(refused(() => billKeyOf(bad)), String(bad)).toBe("validation");
    }
  });

  it("names customers and vendors with the tenant code first", () => {
    expect(customerDisplayName(CODE, { code: "CUST-1", name: "  Test Shipper " })).toBe(
      "T5B0E6F1A2C3D Test Shipper (CUST-1)",
    );
    expect(vendorDisplayName(CODE, { code: "DRV-7", firstName: "Sam", lastName: "Rivera" })).toBe(
      "T5B0E6F1A2C3D Rivera, Sam (DRV-7)",
    );
    expect(refused(() => customerDisplayName(CODE, { code: "cust 1", name: "x" }))).toBe("validation");
    expect(refused(() => customerDisplayName(CODE, { code: "CUST-1", name: "a\nb" }))).toBe("validation");
    expect(vendorBody("T5B0E6F1A2C3D Rivera, Sam (DRV-7)", "company")).toEqual({
      DisplayName: "T5B0E6F1A2C3D Rivera, Sam (DRV-7)",
      Vendor1099: false,
    });
    expect(refused(() => vendorBody("x", "contractor"))).toBe("validation");
  });

  it("refuses invoice lines that are negative, zero, unknown or over the limit", () => {
    const base = {
      actionId: ACTION,
      invoiceNumber: "BR-INV-1",
      customerOutsideId: "58",
      issuedOn: "2026-11-02",
      dueOn: "2026-12-02",
    };
    const line = (over: object) => ({ kind: "linehaul" as const, description: "Linehaul", amountCents: 100, ...over });
    expect(invoiceBody({ ...base, lines: [line({})] }, ITEMS).totalCents).toBe(100);
    for (const lines of [
      [],
      [line({ amountCents: -100 })],
      [line({ amountCents: 0 })],
      [line({ amountCents: 1.5 })],
      [line({ kind: "tip" })],
      [line({ description: " " })],
    ]) {
      expect(refused(() => invoiceBody({ ...base, lines } as never, ITEMS)), JSON.stringify(lines)).toBe(
        "validation",
      );
    }
    expect(refused(() => invoiceBody({ ...base, actionId: "not-a-uuid", lines: [line({})] }, ITEMS))).toBe(
      "validation",
    );
    expect(refused(() => invoiceBody({ ...base, issuedOn: "2026-02-30", lines: [line({})] }, ITEMS))).toBe(
      "validation",
    );
  });

  it("writes a settlement bill whose total is the net pay, on the mapped accounts", () => {
    const out = billBody(
      {
        actionId: ACTION,
        vendorOutsideId: "70",
        driverCode: "DRV-7",
        periodEnd: "2026-11-07",
        lines: [
          { kind: "load_pay", description: "Loads", amountCents: 180_000 },
          { kind: "reimbursement", description: "Tolls", amountCents: 2_500 },
          { kind: "fuel", description: "Fuel", amountCents: -40_000 },
          { kind: "escrow", description: "Escrow", amountCents: -5_000 },
          { kind: "insurance", description: "Insurance", amountCents: 0 },
        ],
      },
      ACCOUNTS,
      KEY,
    );
    expect(out.docNumber).toBe("T5B0E-261107-DRV-7");
    expect(out.totalCents).toBe(137_500);
    const json = JSON.parse(bodyJson(out.body)) as { Line: { Amount: number; AccountBasedExpenseLineDetail: unknown }[] };
    expect(json.Line.map((l) => [l.Amount, l.AccountBasedExpenseLineDetail])).toEqual([
      [1800, { AccountRef: { value: ACCOUNTS.driver_pay } }],
      [25, { AccountRef: { value: ACCOUNTS.driver_reimbursements } }],
      [-400, { AccountRef: { value: ACCOUNTS.driver_chargebacks } }],
      [-50, { AccountRef: { value: ACCOUNTS.driver_escrow } }],
    ]);
  });

  it("refuses a bill with a wrong-signed line, an unknown kind, a non-positive net, a bad key or a long number", () => {
    const bill = (lines: { kind: string; amountCents: number }[], driverCode = "DRV-7", key = KEY) => () =>
      billBody(
        {
          actionId: ACTION,
          vendorOutsideId: "70",
          driverCode,
          periodEnd: "2026-11-07",
          lines: lines.map((l) => ({ ...l, description: "x" })),
        },
        ACCOUNTS,
        key,
      );
    expect(refused(bill([{ kind: "load_pay", amountCents: -1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "fuel", amountCents: 1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "bonus", amountCents: 1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "load_pay", amountCents: 100 }, { kind: "fuel", amountCents: -100 }]))).toBe(
      "validation",
    );
    expect(refused(bill([]))).toBe("validation");
    expect(refused(bill([{ kind: "load_pay", amountCents: 100 }], "DRIVER-LONGER"))).toBe("validation");
    for (const key of ["t5b0e", "T5B0", "T5B0E6", "S5B0E", "", "STL"]) {
      expect(refused(bill([{ kind: "load_pay", amountCents: 100 }], "DRV-7", key)), key).toBe("validation");
    }
    expect(billDocNumber(KEY, "BR-D07", "2026-11-07")).toBe("T5B0E-261107-BR-D07");
    // Intuit's 21 characters: an 8-character driver code fits exactly; a 9-character one is
    // refused, never cut.
    expect(billDocNumber(KEY, "DRV-1234", "2026-11-07")).toBe("T5B0E-261107-DRV-1234");
    expect(billDocNumber(KEY, "DRV-1234", "2026-11-07")).toHaveLength(21);
    expect(refused(() => billDocNumber(KEY, "DRV-12345", "2026-11-07"))).toBe("validation");
    expect(refused(bill([{ kind: "load_pay", amountCents: 100 }], "DRV-12345"))).toBe("validation");
    // Two tenants with one driver code and one period end get two numbers.
    expect(billDocNumber("T7C2A", "BR-D07", "2026-11-07")).not.toBe(billDocNumber(KEY, "BR-D07", "2026-11-07"));
  });

  it("links a bill payment to its bill and draws it from the clearing account", () => {
    const out = billPaymentBody(
      { actionId: ACTION, billOutsideId: "345", vendorOutsideId: "70", amountCents: 137_500, paidOn: "2026-11-09" },
      ACCOUNTS,
    );
    expect(out.docNumber).toBe("BP-345");
    expect(JSON.parse(bodyJson(out.body))).toMatchObject({
      VendorRef: { value: "70" },
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: ACCOUNTS.ledgerline_clearing } },
      TotalAmt: 1375,
      Line: [{ Amount: 1375, LinkedTxn: [{ TxnId: "345", TxnType: "Bill" }] }],
    });
  });

  it("books an advance and its fee as one purchase", () => {
    const out = purchaseBody(
      { actionId: ACTION, vendorOutsideId: "70", amountCents: 20_000, feeCents: 500, onDate: "2026-11-04", docRef: "ADV-1001" },
      ACCOUNTS,
    );
    expect(out.totalCents).toBe(20_500);
    const json = JSON.parse(bodyJson(out.body)) as { Line: { Amount: number }[]; EntityRef: unknown };
    expect(json.EntityRef).toEqual({ value: "70", type: "Vendor" });
    expect(json.Line.map((l) => l.Amount)).toEqual([200, 5]);
    expect(
      refused(() =>
        purchaseBody(
          { actionId: ACTION, vendorOutsideId: "70", amountCents: 1, feeCents: -1, onDate: "2026-11-04", docRef: "ADV-1" },
          ACCOUNTS,
        ),
      ),
    ).toBe("validation");
  });

  it("applies a customer payment to invoices, never more than received and never one invoice twice", () => {
    const pay = (applications: { invoiceOutsideId: string; amountCents: number }[], amountCents = 10_000) =>
      paymentBody(
        {
          actionId: ACTION,
          customerOutsideId: "58",
          paymentRef: "CHK-4471",
          receivedOn: "2026-11-05",
          amountCents,
          applications,
        },
        ACCOUNTS,
      );
    const out = pay([{ invoiceOutsideId: "901", amountCents: 6_000 }]);
    expect(out.docNumber).toBe("CHK-4471");
    expect(JSON.parse(bodyJson(out.body))).toMatchObject({
      TotalAmt: 100,
      PaymentRefNum: "CHK-4471",
      DepositToAccountRef: { value: ACCOUNTS.ledgerline_clearing },
      Line: [{ Amount: 60, LinkedTxn: [{ TxnId: "901", TxnType: "Invoice" }] }],
    });
    expect(refused(() => pay([{ invoiceOutsideId: "901", amountCents: 10_001 }]))).toBe("validation");
    expect(
      refused(() =>
        pay([
          { invoiceOutsideId: "901", amountCents: 1 },
          { invoiceOutsideId: "901", amountCents: 1 },
        ]),
      ),
    ).toBe("validation");
    expect(refused(() => pay([], 0))).toBe("validation");
  });
});

describe("QuickBooks replies", () => {
  it("reads a record whole, or not at all", () => {
    expect(recordOf("Invoice", { Id: "901", DocNumber: "BR-INV-1", TotalAmt: 0.1, CustomerRef: { value: "58" } })).toEqual(
      { id: "901", ref: "BR-INV-1", amountCents: 10, partyId: "58", voided: false, ourNote: false, applied: null, unappliedCents: null },
    );
    expect(recordOf("Payment", { Id: "5", PaymentRefNum: "CHK-1", TotalAmt: 1.005 })).toMatchObject({
      ref: "CHK-1",
      amountCents: null,
    });
    expect(recordOf("Invoice", { Id: 901 })).toBeNull();
    expect(recordOf("Invoice", { Id: "9a" })).toBeNull();
  });

  it("treats a query with no list as empty and a malformed row as unreadable", () => {
    expect(queryRows("Customer", { QueryResponse: {} })).toEqual([]);
    expect(queryRows("Customer", { QueryResponse: { Customer: [{ Id: "1" }] } })).toHaveLength(1);
    expect(queryRows("Customer", { QueryResponse: { Customer: [{ Id: "1" }, { Id: "x" }] } })).toBeNull();
    expect(queryRows("Customer", {})).toBeNull();
  });

  it("reads a voided document as voided: the note, or a zero total", () => {
    const voided = recordOf("Invoice", { Id: "901", TotalAmt: 0, PrivateNote: "Voided - LedgerLine action x" });
    expect(voided).toMatchObject({ voided: true, amountCents: 0 });
    expect(isVoided(voided as never)).toBe(true);
    expect(isVoided(recordOf("Invoice", { Id: "901", TotalAmt: 0 }) as never)).toBe(true);
    expect(isVoided(recordOf("Invoice", { Id: "901", TotalAmt: 5, PrivateNote: "Voided" }) as never)).toBe(true);
    // Only a note that starts with the word counts.
    expect(isVoided(recordOf("Invoice", { Id: "901", TotalAmt: 5, PrivateNote: "Not Voided" }) as never)).toBe(false);
  });

  it("judges a customer payment by its applied lines and its unapplied rest", () => {
    const asked = [
      { invoiceOutsideId: "901", amountCents: 6_000 },
      { invoiceOutsideId: "902", amountCents: 1_000 },
    ];
    const pay = (lines: unknown, unapplied: unknown, total = 100) =>
      recordOf("Payment", { Id: "950", TotalAmt: total, UnappliedAmt: unapplied, Line: lines }) as never;
    const line = (invoice: string, amount: unknown) => ({ Amount: amount, LinkedTxn: [{ TxnId: invoice, TxnType: "Invoice" }] });
    expect(appliedAsAsked(pay([line("901", 60), line("902", 10)], 30), asked)).toBe(true);
    // Cut to the open balance, the rest moved to unapplied, total as sent.
    expect(appliedAsAsked(pay([line("901", 45), line("902", 10)], 45), asked)).toBe(false);
    // A line dropped, an extra line, another invoice, one invoice twice.
    expect(appliedAsAsked(pay([line("901", 60)], 40), asked)).toBe(false);
    expect(appliedAsAsked(pay([line("901", 60), line("902", 10), line("903", 1)], 29), asked)).toBe(false);
    expect(appliedAsAsked(pay([line("901", 60), line("904", 10)], 30), asked)).toBe(false);
    expect(appliedAsAsked(pay([line("901", 60), line("901", 10)], 30), asked)).toBe(false);
    // The unapplied rest must be exactly what was left unapplied, and readable.
    expect(appliedAsAsked(pay([line("901", 60), line("902", 10)], 31), asked)).toBe(false);
    expect(appliedAsAsked(pay([line("901", 60), line("902", 10)], undefined), asked)).toBe(false);
    // A line linking a non-invoice, or two documents, makes the lines unreadable.
    expect(
      appliedAsAsked(pay([{ Amount: 60, LinkedTxn: [{ TxnId: "901", TxnType: "CreditMemo" }] }, line("902", 10)], 30), asked),
    ).toBe(false);
    expect(recordOf("Payment", { Id: "950", TotalAmt: 1, UnappliedAmt: 1, Line: "x" })).toMatchObject({ applied: null });
    // Fully unapplied: no lines at all, and none asked.
    expect(appliedAsAsked(pay(undefined, 100), [])).toBe(true);
  });
});
