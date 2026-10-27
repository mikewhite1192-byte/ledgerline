import { z } from "zod";
import { cents } from "../../../../rules-engine";
import { payCorrectionLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

export const PAY_CORRECTION_REASON_CATEGORIES = [
  "missed_pay",
  "wrong_rate",
  "wrong_driver",
  "duplicate_charge",
  "missing_reimbursement",
  // A charge for something that did not happen (an insurance day with no load).
  "charge_not_owed",
] as const;

export const proposePayCorrection = defineTool({
  name: "propose_pay_correction",
  description:
    "Propose a correction to a driver's pay in an open pay period, for a person to approve. " +
    "Nothing is paid by this call. deltaCents is integer cents: positive adds to pay, negative " +
    "takes away. operatorVerdict follows the sign: owed_to_driver for positive, owed_by_driver " +
    "for negative. payItemId names the item being corrected, when there is one. Corrections " +
    "above the carrier's limit are refused.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the pay correction",
  args: z
    .strictObject({
      driverId: idField(),
      periodId: idField(),
      payItemId: idField().optional(),
      deltaCents: z
        .int()
        .min(-1_000_000)
        .max(1_000_000)
        .refine((n) => n !== 0, { message: "zero" }),
      operatorVerdict: z.enum(["owed_to_driver", "owed_by_driver"]),
      reasonCategories: z.array(z.enum(PAY_CORRECTION_REASON_CATEGORIES)).min(1).max(4),
      sourceRefs: sourceRefsField(),
    })
    // The verdict must agree with the sign. Zero is refused by deltaCents itself, so it adds no
    // second error here. The JSON schema drops this; the gateway's parse enforces it.
    .refine(
      (a) => a.deltaCents === 0 || (a.deltaCents > 0) === (a.operatorVerdict === "owed_to_driver"),
      { path: ["operatorVerdict"], message: "verdict does not match the sign" },
    ),
  refs: (a): GatewayRef[] => [
    { table: "drivers", id: a.driverId },
    { table: "settlement_periods", id: a.periodId },
    ...(a.payItemId ? [{ table: "pay_items" as const, id: a.payItemId }] : []),
    ...refsOf(a.sourceRefs),
  ],
  limit: (q, ctx, a) => payCorrectionLimit(q, ctx, a),
  run: async (_q, _ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const draft = {
      kind: "pay_correction" as const,
      subjectTable: "drivers" as const,
      subjectId: a.driverId,
      amountCents: cents(a.deltaCents),
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
        amountCents: draft.amountCents,
        limitCents: draft.limitCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before any pay changes.",
      },
      draft,
    };
  },
});
