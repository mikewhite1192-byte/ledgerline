import { z } from "zod";
import { readAdvanceInput } from "../../../../data/read";
import { advanceEligibility } from "../../../../rules-engine";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// The engine's answer for an advance without proposing one: the most the driver can draw now,
// the per-load cap and what is left under it, and the suggested amount. Reads only.
export const getAdvanceHeadroom = defineTool({
  name: "get_advance_headroom",
  description:
    "Size an advance without proposing it: the most this driver can draw now, and with loadId " +
    "the load's cap, what is still open on it and what is left, plus a suggested amount in " +
    "whole dollars. amountCents is the ask (integer cents), when there is one. Nothing is written.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Sizing the advance",
  args: z.strictObject({
    driverId: idField(),
    loadId: idField().optional(),
    amountCents: z.int().positive().max(1_000_000).optional(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "drivers", id: a.driverId },
    ...(a.loadId ? [{ table: "loads" as const, id: a.loadId }] : []),
  ],
  run: async (q, ctx, a) => {
    const input = await readAdvanceInput(q, a.driverId, ctx.now.toISOString(), a.amountCents ?? 1, a.loadId);
    // A load that is not this driver's has nothing to size against: said, never guessed.
    if (a.loadId && !input.load) return { result: { loadIsDrivers: false } };
    // With no ask, the engine is asked for the most it allows, so the suggestion and the reasons
    // are about that amount, never about a placeholder.
    const first = advanceEligibility(input);
    const d =
      a.amountCents === undefined && first.maxCents > 0
        ? advanceEligibility({ ...input, amountCents: first.maxCents })
        : first;
    return {
      result: {
        armed: input.driver.moneyArmed,
        maxCents: d.maxCents,
        feeCents: d.feeCents,
        loadCapCents: d.loadCapCents,
        openOnLoadCents: d.openOnLoadCents,
        loadHeadroomCents: d.loadHeadroomCents,
        suggestedCents: d.suggestedCents,
        ...(a.amountCents === undefined ? {} : { eligible: d.eligible }),
        reasons: [...d.reasons],
        sources: d.sources,
      },
    };
  },
});
