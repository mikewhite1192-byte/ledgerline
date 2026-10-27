import { z } from "zod";
import { cents } from "../../../../rules-engine";
import { advanceDailyCap } from "../../daily-cap";
import { advanceLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { dateField, idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

export const ADVANCE_REASON_CATEGORIES = [
  "earned_unpaid_covers",
  "open_advance_exists",
  "over_cap",
  "fee_applies",
  "driver_asked",
] as const;

export const proposeAdvance = defineTool({
  name: "propose_advance",
  description:
    "Propose a pay advance for a person to approve. Nothing is paid by this call. The rules " +
    "engine sizes the limit: an amount above what the driver can draw is refused with the " +
    "limit, and you may propose again at or below it. amountCents is integer cents; " +
    "requestedOn is the date the driver asked (YYYY-MM-DD, not after today); requestRef is the " +
    "outside message the ask came in, when there is one.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking advance eligibility",
  args: z.strictObject({
    driverId: idField(),
    amountCents: z.int().positive().max(1_000_000),
    requestedOn: dateField(),
    operatorVerdict: z.enum(["eligible", "partial", "ineligible"]),
    reasonCategories: z.array(z.enum(ADVANCE_REASON_CATEGORIES)).min(1).max(4),
    sourceRefs: sourceRefsField(),
    requestRef: idField().optional(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "drivers", id: a.driverId },
    ...refsOf(a.sourceRefs),
    ...(a.requestRef ? [{ table: "untrusted_inputs" as const, id: a.requestRef }] : []),
  ],
  // The tenant's daily ceiling on advance proposals first, then the engine's limit.
  limit: async (q, ctx, a) => (await advanceDailyCap(q, ctx, a.amountCents)) ?? advanceLimit(q, ctx, a),
  run: async (_q, _ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const sources: GatewayRef[] = [
      ...limit.sources,
      ...(a.requestRef ? [{ table: "untrusted_inputs" as const, id: a.requestRef }] : []),
    ];
    const draft = {
      kind: "advance_payout" as const,
      subjectTable: "drivers" as const,
      subjectId: a.driverId,
      amountCents: cents(a.amountCents),
      args: { ...a },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources,
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        amountCents: draft.amountCents,
        limitCents: draft.limitCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before anything is paid.",
      },
      draft,
    };
  },
});
