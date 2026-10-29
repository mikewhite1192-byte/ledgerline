import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { BREAK_STATUSES, readBreaks } from "../../../../data/card-recon";
import { defineTool } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// The card check's differences (design 4.3), most severe first. A card shows by its last four
// digits only; the token never leaves the database. Behind the card check's switch, read on every
// offer and every call, and again here.

export const MAX_CARD_BREAKS = 20;

export const getCardBreaks = defineTool({
  name: "get_card_breaks",
  description:
    "List the differences the last card check found between the carrier's payment records, the " +
    "fuel card statement, the bank and QuickBooks, most severe first: the kind of difference, " +
    "both amounts in integer cents, the card's last four digits, the driver if known and what " +
    "fixes it. status defaults to open.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the card check",
  enabled: () => flags.cardRecon.enabled,
  args: z.strictObject({
    status: z.enum(BREAK_STATUSES).optional(),
    limit: z.int().min(1).max(MAX_CARD_BREAKS).optional(),
  }),
  refs: () => [],
  run: async (q, _ctx, a) => {
    if (!flags.cardRecon.enabled) throw new Error("the card check is switched off");
    const status = a.status ?? "open";
    const breaks = await readBreaks(q, status, a.limit ?? MAX_CARD_BREAKS);
    const rows = breaks.map((b) => ({
      id: b.id,
      category: b.category,
      severity: b.severity,
      outsideSystem: b.outsideSystem,
      fixKind: b.fixKind,
      status: b.status,
      dismissCategory: b.dismissCategory,
      ourCents: b.ourCents,
      outsideCents: b.outsideCents,
      explanation: b.explanation,
      proposalId: b.proposalId,
      transaction: b.transaction
        ? {
            id: b.transaction.id,
            kind: b.transaction.kind,
            cardLast4: b.transaction.last4,
            postedOn: b.transaction.postedOn,
            state: b.transaction.state,
            gallonsMilli: b.transaction.gallonsMilli,
            amountCents: b.transaction.amountCents,
          }
        : null,
      record: b.record ? { id: b.record.id, kind: b.record.kind, state: b.record.state } : null,
      fuelPurchaseId: b.purchaseId,
      driver: b.driver,
    }));
    return { result: { status, rows } };
  },
});
