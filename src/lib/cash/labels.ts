import { STAFF_ONLY_NOTE } from "../../components/app/staff-only";
import type { PaymentLabel, ReceiptStatus, VendorBillCategory, VendorBillStatus } from "../rules-engine/types";

// Fixed words for the Cash page. Categories reach the page; these turn them into plain text.

export const BILL_CATEGORY_WORDS: Readonly<Record<VendorBillCategory, string>> = {
  fuel_supplier: "Fuel supplier",
  insurance: "Insurance",
  maintenance: "Shop and tires",
  tolls: "Tolls",
  software: "Software",
  lease: "Truck lease",
  other: "Other",
};

export const RECEIPT_STATUS_WORDS: Readonly<Record<ReceiptStatus, string>> = {
  counted: "Counted for Friday",
  after_pay_day: "Expected after Friday",
  stalled: "Overdue, not counted",
};

export const PAYER_WORDS: Readonly<Record<PaymentLabel, string>> = {
  reliable: "Usually pays on time",
  mixed: "Sometimes pays late",
  repeat_late: "Often pays late",
};

export const BILL_STATUS_WORDS: Readonly<Record<VendorBillStatus, string>> = {
  open: "Open",
  deferred: "Moved",
  paid: "Paid",
};

// Why Check did not give a new position. Each says what happened, that nothing was paid or sent,
// and what to try. A lost or unreadable reply may still have saved a check, so it never says
// nothing was saved.
export const CHECK_NOTICE: Readonly<Record<string, string>> = {
  disabled: "Cash Friday is switched off right now. Nothing was checked.",
  balance_missing: "There is no bank balance on file, so Friday cannot be worked out. Nothing was saved.",
  balance_in_future: "The bank balance is dated after today. Fix its date, then check again. Nothing was saved.",
  no_open_period: "There is no open pay week, so there is no pay run to check. Nothing was saved.",
  more_than_one_open_period: "Two pay weeks are open at once. Close one, then check again. Nothing was saved.",
  pay_run_unknown:
    "This week's pay could not be worked out for every driver, so Friday cannot be checked. Nothing was saved.",
  forbidden: "This login is not linked to a carrier. Sign in with the login your carrier set up.",
  judge: STAFF_ONLY_NOTE,
  no_tenant: "This login is not linked to a carrier. Sign in with the login your carrier set up.",
  unauthenticated: "Your sign-in ended. Sign in again, then check again.",
};

export const CHECK_NOT_CONFIRMED =
  "That check did not confirm. Nothing was paid or sent. The page shows the latest saved check; press the button again to be sure.";

// The card notices the Cash page says in its own words; the rest are the shared ones.
export const CASH_CARD_NOTICES: Readonly<Record<string, string>> = {
  stale: "The bill changed after this card was made. Nothing was moved. Press Check Friday's cash for a fresh card.",
  expired: "This card expired. Nothing was moved. Press Check Friday's cash for a fresh card.",
  not_auditable:
    "This card was made before the second check started. Nothing was moved. Press Check Friday's cash for a fresh card.",
  not_executable: "Cash Friday is switched off right now. Nothing was moved or sent.",
};

// Why the page shows LedgerLine's own sentence instead of Muse Wonder's paragraph.
const EXPLAIN_MISSING: Readonly<Record<string, string>> = {
  figures: "Muse Wonder's paragraph named a dollar amount LedgerLine did not give, so it is not shown.",
  disabled: "Muse Wonder is switched off, so LedgerLine's own sentence is shown.",
  not_configured: "Muse Wonder is not set up here, so LedgerLine's own sentence is shown.",
  timeout: "Muse Wonder took too long, so LedgerLine's own sentence is shown.",
  cap: "The model budget is used up, so LedgerLine's own sentence is shown.",
  job_cap: "The model budget for this hour is used up, so LedgerLine's own sentence is shown.",
  too_expensive: "The model budget for one check is too small, so LedgerLine's own sentence is shown.",
};

export function explainMissing(category: string | null): string | null {
  if (category === null) return null;
  return Object.hasOwn(EXPLAIN_MISSING, category)
    ? EXPLAIN_MISSING[category]
    : "Muse Wonder's paragraph could not be used, so LedgerLine's own sentence is shown.";
}
