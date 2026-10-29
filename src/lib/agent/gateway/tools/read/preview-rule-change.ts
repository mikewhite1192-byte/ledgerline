import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readRuleChangeRows, ruleChangeOf } from "../../../../pay-rules/change";
import { RULE_KEYS } from "../../../../pay-rules/rules";
import { impactLine, refusalLine, ruleTitle, startsLine } from "../../../../pay-rules/words";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR } from "../shared";

// One sentence that changes a pay rule, as a typed change the engine sizes: the rule, its value
// now and after, the week it would start and what it would have done to the newest settled week's
// pay. The new value must appear in the person's own sentence for this turn; the gateway checks
// it, not the model. A change that cannot be made comes back as a category and the one fixed
// question to ask back, never model text. Nothing is written.

export const ruleChangeArgs = {
  ruleKey: z.enum(RULE_KEYS),
  newValue: z.union([z.int(), z.string().max(40), z.null()]),
  askedFrom: dateField(),
};

export const previewRuleChange = defineTool({
  name: "preview_rule_change",
  description:
    "Turn one sentence that changes a pay rule into a typed change. Call it with the rule, the new " +
    "value exactly as the person wrote it (dollars as integer cents, percentages as basis points) " +
    "and the date they named, as YYYY-MM-DD in the carrier's calendar. If the message does not name " +
    "exactly one rule, one new value and one date, do not call this; ask one question instead. " +
    "Returns the old value, the date the change would start, and the engine's impact on the last " +
    "settled week, or why it cannot be made.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading the current rule",
  enabled: () => flags.rulesByTalkingEnabled,
  args: z.strictObject(ruleChangeArgs),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    if (!flags.rulesByTalkingEnabled) throw new Error("pay rule changes are switched off");
    const rows = await readRuleChangeRows(q);
    const check = ruleChangeOf(rows, a, { text: ctx.userText ?? null }, ctx.now);
    if (!check.ok) {
      return {
        result: {
          ok: false,
          category: check.reason,
          // Pass this on as written and ask nothing else.
          askBack: refusalLine(check.reason),
        },
      };
    }
    const c = check.change;
    return {
      result: {
        ok: true,
        ruleKey: c.ruleKey,
        title: ruleTitle(c),
        oldValue: c.oldValue,
        newValue: c.newValue,
        askedFrom: c.askedFrom,
        effectiveFrom: c.effectiveFrom,
        starts: startsLine(c),
        impactCents: c.impact.netDeltaCents,
        impact: {
          basis: c.impact.basis,
          periodStart: c.impact.periodStart,
          periodEnd: c.impact.periodEnd,
          driversCompared: c.impact.driversCompared,
          driversChanged: c.impact.driversChanged,
          netDeltaCents: c.impact.netDeltaCents,
          top: c.impact.top.map((t) => ({ code: t.code, deltaCents: t.deltaCents })),
          line: impactLine(c.impact),
        },
        note:
          "To put this in front of a person, call propose_rule_change with ruleKey, newValue, " +
          "askedFrom, effectiveFrom, oldValue and impactCents exactly as here. Nothing has changed.",
      },
    };
  },
});
