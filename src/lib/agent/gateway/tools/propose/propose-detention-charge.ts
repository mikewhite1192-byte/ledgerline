import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { chargeArgsOf, detentionChargeOf, readDetentionChargeRows } from "../../../../data/detention-charge";
import { cents } from "../../../../rules-engine";
import { detentionChargeLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

// Propose billing a load's unbilled detention on its open invoice. The limit recomputes the
// engine's cents from the rows and refuses any other number; the stored args are the engine's
// figures read again here (stops, instants, terms, the invoice and its amount before), never the
// model's, so the executor can tell at approval whether anything moved.

export const proposeDetentionCharge = defineTool({
  name: "propose_detention_charge",
  description:
    "Propose adding a load's unbilled detention to its open invoice, for a person to approve. " +
    "Nothing is billed, sent or posted by this call. amountCents must equal the amountCents " +
    "find_unbilled_detention returned for that load, in integer cents; any other number is refused.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the detention charge",
  enabled: () => flags.detentionEnabled,
  args: z.strictObject({
    loadId: idField(),
    amountCents: z.int().positive().max(100_000_000),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => [{ table: "loads", id: a.loadId }, ...refsOf(a.sourceRefs)],
  limit: (q, ctx, a) => detentionChargeLimit(q, ctx, a),
  run: async (q, _ctx, a, extras) => {
    if (!flags.detentionEnabled) throw new Error("detention is switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The engine's figures again, in this call's own transaction: the draft stores these.
    const rows = await readDetentionChargeRows(q, a.loadId);
    const check = rows ? detentionChargeOf(rows) : null;
    if (!check || !check.ok || check.charge.amountCents !== a.amountCents) {
      throw new Error("the detention charge changed after its limit");
    }
    const charge = check.charge;
    const draft = {
      kind: "detention_charge" as const,
      subjectTable: "loads" as const,
      subjectId: a.loadId,
      amountCents: cents(charge.amountCents),
      args: chargeArgsOf(charge),
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: [...limit.sources, ...refsOf(a.sourceRefs)],
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        loadId: charge.loadId,
        amountCents: draft.amountCents,
        invoiceId: charge.invoiceId,
        invoiceAmountBeforeCents: charge.invoiceAmountBeforeCents,
        invoiceAmountAfterCents: charge.invoiceAmountAfterCents,
        limitCents: draft.limitCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before the invoice changes.",
      },
      draft,
    };
  },
});
