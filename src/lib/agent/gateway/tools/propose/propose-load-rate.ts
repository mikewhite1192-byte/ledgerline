import { z } from "zod";
import { cents } from "../../../../rules-engine";
import { loadRateLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

// Filling a load's empty rate from its rate confirmation, for a person to approve. No money moves:
// approval writes the two cents values onto the load, and the engine can then price it. The limit
// takes the numbers only when they are exactly the ones read on the named document, the document's
// comparison with the load supports the fill, and miles times the rate per mile is the linehaul.

export const proposeLoadRate = defineTool({
  name: "propose_load_rate",
  description:
    "Propose filling a load's missing rate from its rate confirmation, for a person to approve. " +
    "Nothing changes until a person approves. requestRef is the document's outside input id " +
    "(from get_document). The cents must be exactly the ones read on that document, and " +
    "ratePerMileCents times the load's loaded miles must equal linehaulCents; anything else is " +
    "refused.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the rate fill",
  args: z.strictObject({
    loadId: idField(),
    linehaulCents: z.int().min(1).max(999_999_999),
    fuelSurchargeCents: z.int().min(0).max(999_999_999),
    ratePerMileCents: z.int().min(1).max(99_999),
    requestRef: idField(),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "loads", id: a.loadId },
    { table: "untrusted_inputs", id: a.requestRef },
    ...refsOf(a.sourceRefs),
  ],
  limit: (q, ctx, a) => loadRateLimit(q, ctx, a),
  run: async (_q, _ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const draft = {
      kind: "load_rate_fill" as const,
      subjectTable: "loads" as const,
      subjectId: a.loadId,
      amountCents: cents(0),
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
        linehaulCents: a.linehaulCents,
        fuelSurchargeCents: a.fuelSurchargeCents,
        note: "A person must approve this before the load's rate changes. No money moves.",
      },
      draft,
    };
  },
});
