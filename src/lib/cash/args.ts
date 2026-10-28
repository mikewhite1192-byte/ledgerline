import { z } from "zod";
import { canonicalJson } from "../agent/gateway/store/proposals";
import {
  PAYMENT_LABELS,
  type BillDeferOption,
  type CashOption,
  type ChaseOption,
  type FactoringOption,
  type LocalDate,
} from "../rules-engine";

// What a Cash Friday card stores as its args, built from the engine's option (design 3). The card,
// the auditor's evidence and the executor read them back through these schemas, every field
// checked. Nothing here is model text: ids, codes, dates, cents and the engine's flags.
//
// Days late are left out on purpose: they grow every day, and a card whose invoices and amounts
// have not changed should stay the same card (the dedupe key hashes the args).

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const CENTS = z.int().min(0).max(999_999_999);
const BPS = z.int().min(0).max(10_000);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NUMBER = z.string().regex(/^[A-Za-z0-9-]{1,40}$/);
const BILL_REF = z.string().regex(/^[A-Z0-9-]{3,30}$/);

export const factoringArgsSchema = z.strictObject({
  periodId: UUID,
  payDay: DATE,
  shortCents: CENTS.min(1),
  amountCents: CENTS.min(1),
  advanceBps: BPS,
  feeBps: BPS,
  balanceCents: CENTS.min(1),
  advanceCents: CENTS,
  feeCents: CENTS,
  reserveCents: CENTS,
  coversShort: z.boolean(),
  invoices: z
    .array(
      z.strictObject({
        invoiceId: UUID,
        invoiceNumber: NUMBER,
        customerId: UUID,
        balanceCents: CENTS.min(1),
        advanceCents: CENTS,
        feeCents: CENTS,
        netCents: CENTS,
        reserveCents: CENTS,
      }),
    )
    .min(1)
    .max(10),
  revision: z.int().min(0).optional(),
});
export type FactoringArgs = z.infer<typeof factoringArgsSchema>;

export const billDeferArgsSchema = z.strictObject({
  billId: UUID,
  billRef: BILL_REF,
  amountCents: CENTS.min(1),
  dueOn: DATE,
  deferredTo: DATE,
  payDay: DATE,
  shortCents: CENTS.min(1),
  coversShort: z.boolean(),
  revision: z.int().min(0).optional(),
});
export type BillDeferArgs = z.infer<typeof billDeferArgsSchema>;

export const chaseArgsSchema = z.strictObject({
  customerId: UUID,
  amountCents: CENTS.min(1),
  label: z.enum(PAYMENT_LABELS),
  overdueInvoices: z.int().min(1).max(100_000),
  invoices: z
    .array(z.strictObject({ invoiceId: UUID, invoiceNumber: NUMBER, balanceCents: CENTS.min(1), dueOn: DATE }))
    .min(1)
    .max(8),
  revision: z.int().min(0).optional(),
});
export type ChaseArgs = z.infer<typeof chaseArgsSchema>;

export function factoringArgsOf(o: FactoringOption, payDay: LocalDate, shortCents: number): FactoringArgs {
  return {
    periodId: o.subjectId,
    payDay,
    shortCents,
    amountCents: o.amountCents,
    advanceBps: o.advanceBps,
    feeBps: o.feeBps,
    balanceCents: o.balanceCents,
    advanceCents: o.advanceCents,
    feeCents: o.feeCents,
    reserveCents: o.reserveCents,
    coversShort: o.coversShort,
    invoices: o.invoices.map((i) => ({
      invoiceId: i.invoiceId,
      invoiceNumber: i.invoiceNumber,
      customerId: i.customerId,
      balanceCents: i.balanceCents,
      advanceCents: i.advanceCents,
      feeCents: i.feeCents,
      netCents: i.netCents,
      reserveCents: i.reserveCents,
    })),
  };
}

export function billDeferArgsOf(o: BillDeferOption, payDay: LocalDate, shortCents: number): BillDeferArgs {
  return {
    billId: o.subjectId,
    billRef: o.billRef,
    amountCents: o.amountCents,
    dueOn: o.dueOn,
    deferredTo: o.deferredTo,
    payDay,
    shortCents,
    coversShort: o.coversShort,
  };
}

export function chaseArgsOf(o: ChaseOption): ChaseArgs {
  return {
    customerId: o.subjectId,
    amountCents: o.amountCents,
    label: o.label,
    overdueInvoices: o.overdueInvoices,
    invoices: o.invoices.map((i) => ({
      invoiceId: i.invoiceId,
      invoiceNumber: i.invoiceNumber,
      balanceCents: i.balanceCents,
      dueOn: i.dueOn,
    })),
  };
}

export function optionArgs(o: CashOption, payDay: LocalDate, shortCents: number): Record<string, unknown> {
  if (o.kind === "factoring_request") return factoringArgsOf(o, payDay, shortCents);
  if (o.kind === "bill_defer") return billDeferArgsOf(o, payDay, shortCents);
  return chaseArgsOf(o);
}

// The fixed reason categories a card carries (src/lib/agent/reasons.ts has the sentences).
export function optionReasons(o: CashOption): string[] {
  if (o.kind === "factoring_request") {
    return [o.coversShort ? "covers_short" : "narrows_short", "factoring_test_mode"];
  }
  if (o.kind === "bill_defer") {
    return ["bill_flexible", "due_before_pay_day", o.coversShort ? "covers_short" : "narrows_short"];
  }
  return [...(o.label === "repeat_late" ? ["repeat_late_payer"] : []), "past_due_balance", "collections_test_mode"];
}

// Whole-value equality of stored args (its revision aside) and args built from the engine now.
export function sameArgs(stored: Record<string, unknown>, now: Record<string, unknown>): boolean {
  const strip = (a: Record<string, unknown>) => {
    const rest = { ...a };
    delete rest.revision;
    return rest;
  };
  return canonicalJson(strip(stored)) === canonicalJson(strip(now));
}

export function parseArgsText(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
