import { z } from "zod";
import { readAdvanceInput } from "../../../../data/read";
import { advanceEligibility, cents } from "../../../../rules-engine";
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
    "Propose a pay advance for a person to approve. Nothing is paid by this call. It checks the " +
    "driver itself (one of this carrier's, armed to receive money, and the advance headroom the " +
    "rules engine sizes), so call it directly with driverId and amountCents; do not read " +
    "identity, arming or headroom first. A refusal returns only a reason category, and the limit " +
    "when there is one; after engine_refused, get_advance_headroom gives the engine's reasons. An " +
    "amount above what the driver can draw is refused with the limit, and you may propose again " +
    "at or below it. amountCents is integer cents; " +
    "requestedOn is the date the driver asked (YYYY-MM-DD, not after today); requestRef is the " +
    "outside message the ask came in, when there is one. loadId is the load the advance is for, " +
    "when the driver named one: the carrier's per-load cap then applies. cardId names one of the " +
    "driver's active cards other than the default; leave it out to pay the default card.",
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
    loadId: idField().optional(),
    // Not a gateway table: the limit checks it is one of the driver's active cards, and a card
    // that is not stays on the proposal as an exception.
    cardId: idField().optional(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "drivers", id: a.driverId },
    ...refsOf(a.sourceRefs),
    ...(a.requestRef ? [{ table: "untrusted_inputs" as const, id: a.requestRef }] : []),
    ...(a.loadId ? [{ table: "loads" as const, id: a.loadId }] : []),
  ],
  // The tenant's daily ceiling on advance proposals first, then the engine's limit.
  limit: async (q, ctx, a) => (await advanceDailyCap(q, ctx, a.amountCents)) ?? advanceLimit(q, ctx, a),
  run: async (q, ctx, a, extras) => {
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    const sources: GatewayRef[] = [
      ...limit.sources,
      ...(a.requestRef ? [{ table: "untrusted_inputs" as const, id: a.requestRef }] : []),
    ];
    // The per-load numbers at proposal time, in this call's own transaction, for the card's load
    // line. The executor sizes the advance again when a person approves it.
    const load = a.loadId ? await loadFactsOf(q, ctx.now, a.driverId, a.amountCents, a.loadId) : null;
    const draft = {
      kind: "advance_payout" as const,
      subjectTable: "drivers" as const,
      subjectId: a.driverId,
      amountCents: cents(a.amountCents),
      args: { ...a, ...(load ? { load } : {}) },
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
        ...(load ? { load } : {}),
        note: "A person must approve this before anything is paid.",
      },
      draft,
    };
  },
});

// The load's number and its cap, with what is left under it after this advance and its fee.
// capCents is null when the carrier has no per-load cap.
export type AdvanceLoadFacts = { number: string; capCents: number | null; leftAfterCents: number | null };

async function loadFactsOf(
  q: Parameters<typeof readAdvanceInput>[0],
  now: Date,
  driverId: string,
  amountCents: number,
  loadId: string,
): Promise<AdvanceLoadFacts> {
  const input = await readAdvanceInput(q, driverId, now.toISOString(), amountCents, loadId);
  if (!input.load) throw new Error("the load changed after its limit");
  const rows = await q.query<{ load_number: string }>(
    "SELECT load_number FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [loadId],
  );
  if (rows.length !== 1) throw new Error("the load changed after its limit");
  const d = advanceEligibility(input);
  if (d.loadCapCents === null || d.loadHeadroomCents === null) {
    return { number: rows[0].load_number, capCents: null, leftAfterCents: null };
  }
  return {
    number: rows[0].load_number,
    capCents: d.loadCapCents,
    leftAfterCents: Math.max(0, d.loadHeadroomCents - amountCents - d.feeCents),
  };
}
