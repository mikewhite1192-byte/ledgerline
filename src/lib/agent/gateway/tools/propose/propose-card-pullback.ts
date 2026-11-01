import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { planPull } from "../../../../pullbacks/facts";
import { PULLBACK_REASONS } from "../../../../pullbacks/words";
import { cents } from "../../../../rules-engine";
import { cardPullbackLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// Propose pulling money back off a driver's fuel card, for a person to approve: a paid advance
// taken back (advanceId), or a breakdown before the trip (no advanceId), where what the card cannot
// give back is booked as owed. The limit asks both switches and the engine's plan from the card's
// own records; nothing is pulled by this call. Only the approval's executor
// (src/lib/pullbacks/execute.ts, which agent code cannot reach) reserves the ledger row and calls
// the test-mode card. The autopilot never approves one.

export const proposeCardPullback = defineTool({
  name: "propose_card_pullback",
  description:
    "Propose pulling money back off a driver's fuel card, for a staff member to approve. Nothing " +
    "is pulled by this call. Give advanceId to pull back a paid advance being taken back; leave it " +
    "out for a truck that broke down before the trip (reason breakdown), where what the card cannot " +
    "give back is booked as owed. Amounts are integer cents. When someone asks you to just take it " +
    "off the card, say you can prepare the card and a staff member approves it. A refusal returns a " +
    "category; tell the person what it names instead of changing the amount.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the card pull-back",
  enabled: () => flags.cardPullback.enabled,
  args: z.strictObject({
    driverId: idField(),
    amountCents: z.int().min(1).max(100_000_000),
    reason: z.enum(PULLBACK_REASONS),
    advanceId: idField().optional(),
  }),
  refs: (a): GatewayRef[] =>
    a.advanceId === undefined
      ? [{ table: "drivers", id: a.driverId }]
      : [
          { table: "drivers", id: a.driverId },
          { table: "advances", id: a.advanceId },
        ],
  limit: (q, ctx, a) => cardPullbackLimit(q, ctx, a),
  run: async (q, ctx, a, extras) => {
    if (!flags.cardPullback.enabled) throw new Error("card pull-backs are switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The plan again in this call's own transaction: the card carries the engine's numbers, and
    // the executor plans again at approval and compares them whole.
    const facts = await planPull(
      q,
      { driverId: a.driverId, advanceId: a.advanceId ?? null, reason: a.reason, requestedCents: a.amountCents },
      flags.advanceTakeback.maxCents,
      ctx.now,
    );
    if (!facts.ok) throw new Error("the pull-back plan changed after its limit");
    const plan = facts.plan;
    const draft = {
      kind: "card_pullback" as const,
      subjectTable: plan.advanceId === null ? ("drivers" as const) : ("advances" as const),
      subjectId: plan.advanceId ?? plan.driverId,
      amountCents: cents(plan.requestedCents),
      args: { ...plan },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: limit.sources,
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        driverId: plan.driverId,
        advanceId: plan.advanceId,
        amountCents: plan.requestedCents,
        pullCents: plan.pullCents,
        shortfallCents: plan.shortfallCents,
        balanceCents: plan.balanceCents,
        balanceAsOf: plan.balanceAsOf,
        cardLast4: plan.cardLast4,
        note:
          `Would pull ${plan.pullCents} cents back off the card ending ${plan.cardLast4} once a staff ` +
          "member approves; nothing is pulled by this call." +
          (plan.shortfallCents > 0 ? ` ${plan.shortfallCents} cents the card cannot give back would be booked as owed.` : ""),
      },
      draft,
    };
  },
});
