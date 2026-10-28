import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { changeArgsOf, readRuleChangeRows, ruleChangeOf } from "../../../../pay-rules/change";
import { cents } from "../../../../rules-engine";
import { ruleChangeLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";
import { ruleChangeArgs } from "../read/preview-rule-change";

// Propose the pay rule change preview_rule_change returned, for a person to approve. The limit
// re-runs the same check and refuses any field that differs from the engine's (the start date,
// the old value, the weekly impact); the stored args are the engine's figures read again here,
// never the model's, so the executor can tell at approval whether anything moved. Nothing changes
// until a person approves.

export const proposeRuleChange = defineTool({
  name: "propose_rule_change",
  description:
    "Propose the rule change preview_rule_change returned, for a person to approve. Every field " +
    "must equal what the preview returned; any difference is refused. Nothing changes until a " +
    "person approves.",
  tier: "propose",
  roles: OPERATOR,
  label: "Sizing the change on last week's pay",
  enabled: () => flags.rulesByTalkingEnabled,
  args: z.strictObject({
    ...ruleChangeArgs,
    effectiveFrom: dateField(),
    oldValue: z.union([z.int(), z.string().max(40), z.null()]),
    impactCents: z.int().min(-999_999_999).max(999_999_999),
    sourceRefs: sourceRefsField(),
  }),
  refs: (a): GatewayRef[] => refsOf(a.sourceRefs),
  limit: (q, ctx, a) => ruleChangeLimit(q, ctx, a),
  run: async (q, ctx, a, extras) => {
    if (!flags.rulesByTalkingEnabled) throw new Error("pay rule changes are switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The engine's figures again, in this call's own transaction: the draft stores these.
    const rows = await readRuleChangeRows(q);
    const check = ruleChangeOf(rows, a, { text: ctx.userText ?? null }, ctx.now);
    if (
      !check.ok ||
      check.change.effectiveFrom !== a.effectiveFrom ||
      check.change.oldValue !== a.oldValue ||
      check.change.impact.netDeltaCents !== a.impactCents
    ) {
      throw new Error("the rule change moved after its limit");
    }
    const change = check.change;
    const draft = {
      kind: "pay_rule_change" as const,
      subjectTable: "pay_configs" as const,
      subjectId: change.baseVersionId,
      amountCents: cents(change.impact.netDeltaCents),
      args: changeArgsOf(change),
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: [...limit.sources, ...refsOf(a.sourceRefs)],
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        ruleKey: change.ruleKey,
        effectiveFrom: change.effectiveFrom,
        impactCents: change.impact.netDeltaCents,
        limitCents: draft.limitCents,
        note: "A person must save this before any pay rule changes. Past weeks never change.",
      },
      draft,
    };
  },
});
