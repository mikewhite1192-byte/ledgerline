import { flags } from "../../config/flags";
import { MoneyError } from "../money/types";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "./payment/mock";
import { dbTmsAdapter } from "./tms/db";
import type { AccountingAdapter, PaymentAdapter, TmsAdapter } from "./types";

export type * from "./types";

// The adapters the app runs with, chosen per call from the release switches. Tests inject fakes
// into the money executor instead of calling these.

let mock: MockPaymentAdapter | undefined;

// Stripe test mode and the QuickBooks sandbox arrive in the next change. Until then each answers
// not_configured on every call, so nothing outside is ever reached through them.
const stripeNotConfigured: PaymentAdapter = {
  system: "stripe_test",
  ready: async () => ({ ok: false, category: "not_configured" }),
  sendPayout: async () => ({ kind: "failed", category: "not_configured" }),
  readBack: async () => {
    throw new MoneyError("not_configured");
  },
};

function refuse(): never {
  throw new MoneyError("not_configured");
}

const accountingNotConfigured: AccountingAdapter = {
  system: "qbo_sandbox",
  ready: async () => ({
    ok: false,
    category: flags.accountingEnabled === true ? "not_configured" : "disabled",
  }),
  ensureCustomer: async () => refuse(),
  ensureVendor: async () => refuse(),
  createInvoice: async () => ({ kind: "failed", category: "not_configured" }),
  createBill: async () => ({ kind: "failed", category: "not_configured" }),
  payBill: async () => ({ kind: "failed", category: "not_configured" }),
  createExpense: async () => ({ kind: "failed", category: "not_configured" }),
  recordCustomerPayment: async () => ({ kind: "failed", category: "not_configured" }),
  readBack: async () => refuse(),
};

export function paymentAdapter(): PaymentAdapter {
  if (flags.paymentProvider === "mock") return (mock ??= createMockPaymentAdapter());
  return stripeNotConfigured;
}

export function accountingAdapter(): AccountingAdapter {
  return accountingNotConfigured;
}

export function tmsAdapter(): TmsAdapter {
  return dbTmsAdapter;
}
