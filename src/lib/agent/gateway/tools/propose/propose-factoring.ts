import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { factoringProposalOf } from "../../../../factoring/propose";
import { cents } from "../../../../rules-engine";
import { factoringLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

// Propose factoring exactly the invoices named, for a person to approve (design 4.4). The model
// names invoices and never a number: the rules engine sizes every invoice's advance, fee, reserve
// and the net at the carrier's rates, on the week Cash Friday reads, and the stored args are those
// figures, so the approval can tell whether anything moved before anything is sent.

export const proposeFactoring = defineTool({
  name: "propose_factoring",
  description:
    "Propose selling one to three open load invoices to the factoring partner for cash now, for a " +
    "person to approve. Test mode: nothing is sent and no money moves by this call. The rules " +
    "engine works out every invoice's advance, fee and the part held back until the customer pays, " +
    "in integer cents; only offered when Friday's pay run is short. If refused, get_factoring_packet " +
    "says which invoice cannot be factored and why.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the factoring request",
  enabled: () => flags.factoring?.enabled === true,
  args: z.strictObject({
    invoiceIds: z.array(idField()).min(1).max(3),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => [
    ...a.invoiceIds.map((id): GatewayRef => ({ table: "invoices", id })),
    ...refsOf(a.sourceRefs),
  ],
  limit: (q, ctx, a) => factoringLimit(q, ctx, a),
  run: async (q, ctx, a, extras) => {
    if (flags.factoring?.enabled !== true) throw new Error("factoring is switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The engine's figures again, in this call's own transaction: the draft stores these.
    const p = await factoringProposalOf(q, ctx.timeZone, ctx.now, a.invoiceIds);
    if (!p.ok || p.option.amountCents !== limit.requestedCents) {
      throw new Error("the factoring request changed after its limit");
    }
    const o = p.option;
    const draft = {
      kind: "factoring_request" as const,
      subjectTable: "settlement_periods" as const,
      subjectId: o.subjectId,
      amountCents: cents(o.amountCents),
      args: p.args,
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: [...limit.sources, ...refsOf(a.sourceRefs)],
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        periodId: o.subjectId,
        netCents: o.amountCents,
        advanceCents: o.advanceCents,
        feeCents: o.feeCents,
        reserveCents: o.reserveCents,
        coversShort: o.coversShort,
        invoices: o.invoices.map((l) => ({
          invoiceId: l.invoiceId,
          invoiceNumber: l.invoiceNumber,
          balanceCents: l.balanceCents,
          netCents: l.netCents,
          reserveCents: l.reserveCents,
        })),
        limitCents: draft.limitCents,
        note: "A person must approve this before anything is sent. Test mode.",
      },
      draft,
    };
  },
});
