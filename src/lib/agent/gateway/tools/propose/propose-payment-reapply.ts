import { z } from "zod";
import { paymentReapplyLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

export const proposePaymentReapply = defineTool({
  name: "propose_payment_reapply",
  description:
    "Propose moving a customer payment's application from the invoice it sits on to the open " +
    "invoice it was meant for, for a person to approve. Only a payment_on_wrong_invoice finding " +
    "from run_checks qualifies: the four ids must be exactly that finding's sources, in its " +
    "order (payment, application, the invoice it is on, the invoice it was meant for). Nothing " +
    "moves by this call.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the payment move",
  args: z.strictObject({
    paymentId: idField(),
    applicationId: idField(),
    fromInvoiceId: idField(),
    toInvoiceId: idField(),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "customer_payments", id: a.paymentId },
    { table: "payment_applications", id: a.applicationId },
    { table: "invoices", id: a.fromInvoiceId },
    { table: "invoices", id: a.toInvoiceId },
    ...refsOf(a.sourceRefs),
  ],
  limit: (q, ctx, a) => paymentReapplyLimit(q, ctx, a),
  run: async (_q, _ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const draft = {
      kind: "payment_reapply" as const,
      subjectTable: "payment_applications" as const,
      subjectId: a.applicationId,
      amountCents: limit.requestedCents,
      args: {
        paymentId: a.paymentId,
        applicationId: a.applicationId,
        fromInvoiceId: a.fromInvoiceId,
        toInvoiceId: a.toInvoiceId,
        amountCents: limit.requestedCents,
      },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: [...limit.sources, ...refsOf(a.sourceRefs)],
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        amountCents: draft.amountCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before the payment moves.",
      },
      draft,
    };
  },
});
