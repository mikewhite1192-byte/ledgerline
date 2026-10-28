import { daysBetween } from "../time/local-date";
import { invoiceStatus, paymentProfile } from "./receivables";
import { sum } from "./money";
import {
  assertDate,
  compareText,
  InputError,
  type Cents,
  type LocalDate,
  type PaymentLabel,
  type PaymentProfile,
  type ReceivablesInput,
  type SourceRef,
} from "./types";

// Collections (design 3.2): which open invoices get a payment reminder, at which stage and in
// which tone. Pure: the caller reads the invoices, payments and applications and passes the
// tenant-local date. The stage follows how late the invoice is; the tone follows the stage and how
// the customer has paid (paymentProfile). Three fixed tones, so the words a model writes later
// never pick the posture. Nothing here moves or asks for money; it only lists.

export const COLLECTION_STAGES = ["30", "60", "90"] as const;
export type CollectionStage = (typeof COLLECTION_STAGES)[number];

export const COLLECTION_TONES = ["friendly", "direct", "firm"] as const;
export type CollectionTone = (typeof COLLECTION_TONES)[number];

// 90 or more days late is the 90 stage, 60 or more the 60 stage, anything else the 30 stage. The
// planner only asks for invoices at least minDaysLate late, so a stage below 30 never comes up.
export function collectionStage(daysLate: number): CollectionStage {
  if (!Number.isSafeInteger(daysLate) || daysLate < 0) throw new InputError("daysLate is not a whole number of days");
  if (daysLate >= 90) return "90";
  if (daysLate >= 60) return "60";
  return "30";
}

// reliable: friendly at every stage. mixed: friendly at 30, direct at 60 and 90. repeat_late:
// direct at 30, firm at 60 and 90.
export function collectionTone(label: PaymentLabel, stage: CollectionStage): CollectionTone {
  if (label === "reliable") return "friendly";
  if (label === "mixed") return stage === "30" ? "friendly" : "direct";
  if (label === "repeat_late") return stage === "30" ? "direct" : "firm";
  throw new InputError("not a payment label");
}

export type ChaseCandidate = {
  invoiceId: string;
  customerId: string;
  invoiceNumber: string;
  amountCents: Cents;
  balanceCents: Cents;
  dueOn: LocalDate;
  // Whole days from the due date to asOf, both tenant-local dates.
  daysLate: number;
  stage: CollectionStage;
  tone: CollectionTone;
  profile: PaymentProfile;
  sources: SourceRef[];
};

// Every invoice that is not void, still owes money (from its applications, not its stored status)
// and is at least minDaysLate days past due on input.asOf. customerIds null means every customer;
// a list keeps only those customers' invoices. The most overdue come first, then by invoice
// number, so a run that stops at its cap has reached the oldest debts.
export function planCollections(
  input: ReceivablesInput,
  customerIds: readonly string[] | null,
  minDaysLate: number,
): ChaseCandidate[] {
  const asOf = assertDate(input.asOf, "asOf");
  if (!Number.isSafeInteger(minDaysLate) || minDaysLate < 1) {
    throw new InputError("minDaysLate is not a whole number of days");
  }
  const only = customerIds === null ? null : new Set(customerIds);
  const applied = new Map<string, number>();
  for (const a of input.applications) {
    applied.set(a.invoiceId, sum([applied.get(a.invoiceId) ?? 0, a.amountCents]));
  }
  const profiles = new Map<string, PaymentProfile>();
  const profileOf = (customerId: string): PaymentProfile => {
    let p = profiles.get(customerId);
    if (!p) {
      p = paymentProfile(customerId, input, asOf);
      profiles.set(customerId, p);
    }
    return p;
  };

  const out: ChaseCandidate[] = [];
  for (const invoice of input.invoices) {
    if (invoice.status === "void") continue;
    if (only !== null && !only.has(invoice.customerId)) continue;
    const dueOn = assertDate(invoice.dueOn, `invoice ${invoice.id} dueOn`);
    const daysLate = daysBetween(dueOn, asOf);
    if (daysLate < minDaysLate) continue;
    const { status, balanceCents } = invoiceStatus(invoice.amountCents, applied.get(invoice.id) ?? 0);
    if (status === "paid" || balanceCents <= 0) continue;
    const profile = profileOf(invoice.customerId);
    const stage = collectionStage(daysLate);
    out.push({
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      invoiceNumber: invoice.invoiceNumber,
      amountCents: invoice.amountCents,
      balanceCents,
      dueOn,
      daysLate,
      stage,
      tone: collectionTone(profile.label, stage),
      profile,
      sources: [
        { table: "invoices", id: invoice.id },
        { table: "customers", id: invoice.customerId },
      ],
    });
  }
  return out.sort(
    (a, b) =>
      b.daysLate - a.daysLate ||
      compareText(a.invoiceNumber, b.invoiceNumber) ||
      compareText(a.invoiceId, b.invoiceId),
  );
}
