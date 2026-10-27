import { describe, expect, it } from "vitest";
import { MoneyError } from "../../../money/types";
import {
  billBody,
  billDocNumber,
  billPaymentBody,
  customerDisplayName,
  invoiceBody,
  paymentBody,
  purchaseBody,
  queryRows,
  recordOf,
  vendorBody,
  vendorDisplayName,
} from "./entities";
import { ACCOUNTS, ITEMS } from "./test-fakes";
import { bodyJson, decimalField, faultCodes } from "./wire";

const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

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
  it("names customers and vendors with the tenant code first", () => {
    expect(customerDisplayName("BR", { code: "CUST-1", name: "  Test Shipper " })).toBe("BR Test Shipper (CUST-1)");
    expect(vendorDisplayName("BR", { code: "DRV-7", firstName: "Sam", lastName: "Rivera" })).toBe(
      "BR Rivera, Sam (DRV-7)",
    );
    expect(refused(() => customerDisplayName("BR", { code: "cust 1", name: "x" }))).toBe("validation");
    expect(refused(() => customerDisplayName("BR", { code: "CUST-1", name: "a\nb" }))).toBe("validation");
    expect(vendorBody("BR Rivera, Sam (DRV-7)", "company")).toEqual({
      DisplayName: "BR Rivera, Sam (DRV-7)",
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
    );
    expect(out.docNumber).toBe("STL-261107-DRV-7");
    expect(out.totalCents).toBe(137_500);
    const json = JSON.parse(bodyJson(out.body)) as { Line: { Amount: number; AccountBasedExpenseLineDetail: unknown }[] };
    expect(json.Line.map((l) => [l.Amount, l.AccountBasedExpenseLineDetail])).toEqual([
      [1800, { AccountRef: { value: ACCOUNTS.driver_pay } }],
      [25, { AccountRef: { value: ACCOUNTS.driver_reimbursements } }],
      [-400, { AccountRef: { value: ACCOUNTS.driver_chargebacks } }],
      [-50, { AccountRef: { value: ACCOUNTS.driver_escrow } }],
    ]);
  });

  it("refuses a bill with a wrong-signed line, an unknown kind, a non-positive net or a long number", () => {
    const bill = (lines: { kind: string; amountCents: number }[], driverCode = "DRV-7") => () =>
      billBody(
        {
          actionId: ACTION,
          vendorOutsideId: "70",
          driverCode,
          periodEnd: "2026-11-07",
          lines: lines.map((l) => ({ ...l, description: "x" })),
        },
        ACCOUNTS,
      );
    expect(refused(bill([{ kind: "load_pay", amountCents: -1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "fuel", amountCents: 1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "bonus", amountCents: 1 }]))).toBe("validation");
    expect(refused(bill([{ kind: "load_pay", amountCents: 100 }, { kind: "fuel", amountCents: -100 }]))).toBe(
      "validation",
    );
    expect(refused(bill([]))).toBe("validation");
    expect(refused(bill([{ kind: "load_pay", amountCents: 100 }], "DRIVER-LONGER"))).toBe("validation");
    expect(billDocNumber("DRV-77", "2026-11-07")).toBe("STL-261107-DRV-77");
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
      { id: "901", ref: "BR-INV-1", amountCents: 10, partyId: "58" },
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
});
