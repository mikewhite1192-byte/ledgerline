import { z } from "zod";
import { flags } from "../../config/flags";
import { invoiceStatus } from "../rules-engine";
import { addDays, isLocalDate, type LocalDate } from "../time/local-date";
import { MAX_MEMO, PAYMENT_METHODS, PAYMENT_REF } from "./form-text";

// A customer payment as a person types it, checked before anything is read or written. Pure, so
// the form and the server agree and a unit test covers every rule.

export { MAX_MEMO, PAYMENT_METHODS, PAYMENT_REF } from "./form-text";
export const MAX_APPLICATIONS = 20;
// How far back a received date may be, in days before today in the carrier's zone.
export const RECEIVED_WINDOW_DAYS = 365;

// Printable text only: no control characters in a memo that a page shows back.
const PRINTABLE = /^[^\p{Cc}]*$/u;

export const PaymentInputSchema = z.strictObject({
  customerId: z.uuid(),
  receivedOn: z.string().refine(isLocalDate),
  amountCents: z.int().positive(),
  method: z.enum(PAYMENT_METHODS),
  paymentRef: z.string().regex(PAYMENT_REF),
  memo: z.string().max(MAX_MEMO).regex(PRINTABLE).optional(),
  applications: z
    .array(z.strictObject({ invoiceId: z.uuid(), amountCents: z.int().positive() }))
    .max(MAX_APPLICATIONS),
});

export type PaymentInput = z.infer<typeof PaymentInputSchema>;

export type InputCheck =
  | { ok: true; input: PaymentInput }
  | { ok: false; category: "validation" | "limit" | "over_applied" };

// Shape, the date window around today (the carrier's own date), the amount cap, distinct invoices,
// and no more applied than received.
export function checkPaymentInput(raw: unknown, today: LocalDate): InputCheck {
  const parsed = PaymentInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, category: "validation" };
  const input = parsed.data;
  if (input.receivedOn > today || input.receivedOn < addDays(today, -RECEIVED_WINDOW_DAYS)) {
    return { ok: false, category: "validation" };
  }
  if (input.amountCents > flags.customerPaymentLimits.maxCents) return { ok: false, category: "limit" };
  const ids = input.applications.map((a) => a.invoiceId);
  if (new Set(ids).size !== ids.length) return { ok: false, category: "validation" };
  const applied = input.applications.reduce((sum, a) => sum + a.amountCents, 0);
  if (applied > input.amountCents) return { ok: false, category: "over_applied" };
  return { ok: true, input };
}

// One invoice a payment may apply to, as it stands before this payment.
export type OpenInvoice = {
  id: string;
  customerId: string;
  status: string;
  amountCents: number;
  appliedCents: number;
};

// Each application against its invoice: the customer's own, still open or partly paid, and no
// more than that invoice still owes, compared whole. Whatever is not applied stays as credit.
export function checkApplications(
  customerId: string,
  applications: readonly { invoiceId: string; amountCents: number }[],
  invoices: readonly OpenInvoice[],
): { ok: true } | { ok: false; category: "validation" | "over_applied" } {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  for (const a of applications) {
    const invoice = byId.get(a.invoiceId);
    if (!invoice || invoice.customerId !== customerId) return { ok: false, category: "validation" };
    if (invoice.status !== "open" && invoice.status !== "partially_paid") {
      return { ok: false, category: "over_applied" };
    }
    const { balanceCents } = invoiceStatus(invoice.amountCents, invoice.appliedCents);
    if (a.amountCents > balanceCents) return { ok: false, category: "over_applied" };
  }
  return { ok: true };
}
