import { z } from "zod";
import { cents } from "../../../../rules-engine";
import { invoiceFixLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

export const INVOICE_FIX_REASON_CATEGORIES = [
  "rate_mismatch",
  "missing_accessorial",
  "fuel_surcharge_wrong",
  "duplicate_line",
] as const;

export const proposeInvoiceFix = defineTool({
  name: "propose_invoice_fix",
  description:
    "Propose correcting an open load invoice to the total the rules engine computes from the " +
    "load, for a person to approve. Nothing is sent or posted by this call. newAmountCents must " +
    "equal the engine's total for that load, in integer cents; any other number is refused.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the invoice fix",
  args: z.strictObject({
    invoiceId: idField(),
    newAmountCents: z.int().positive().max(100_000_000),
    reasonCategories: z.array(z.enum(INVOICE_FIX_REASON_CATEGORIES)).min(1).max(4),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => [{ table: "invoices", id: a.invoiceId }, ...refsOf(a.sourceRefs)],
  limit: (q, ctx, a) => invoiceFixLimit(q, ctx, a),
  run: async (_q, _ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const draft = {
      kind: "invoice_fix" as const,
      subjectTable: "invoices" as const,
      subjectId: a.invoiceId,
      amountCents: cents(a.newAmountCents),
      args: { ...a },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: [...limit.sources, ...refsOf(a.sourceRefs)],
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        newAmountCents: draft.amountCents,
        changeCents: limit.requestedCents,
        limitCents: draft.limitCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before the invoice changes.",
      },
      draft,
    };
  },
});
