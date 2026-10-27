import { flags } from "../../config/flags";
import { createQboAdapter } from "./accounting/qbo/adapter";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "./payment/mock";
import { createStripeTestAdapter } from "./payment/stripe-test";
import { dbTmsAdapter } from "./tms/db";
import type { AccountingAdapter, PaymentAdapter, TmsAdapter } from "./types";

export type * from "./types";

// The adapters the app runs with, chosen per call from the release switches. Tests inject fakes
// into the money executor instead of calling these.

let mock: MockPaymentAdapter | undefined;
let stripe: PaymentAdapter | undefined;
let qbo: AccountingAdapter | undefined;

// Each adapter checks its own switch, settings and secrets on every call, so choosing one here
// sends nothing: with payoutsEnabled or accountingEnabled off, every write refuses "disabled".
export function paymentAdapter(): PaymentAdapter {
  if (flags.paymentProvider === "stripe_test") return (stripe ??= createStripeTestAdapter());
  return (mock ??= createMockPaymentAdapter());
}

export function accountingAdapter(): AccountingAdapter {
  return (qbo ??= createQboAdapter());
}

export function tmsAdapter(): TmsAdapter {
  return dbTmsAdapter;
}
