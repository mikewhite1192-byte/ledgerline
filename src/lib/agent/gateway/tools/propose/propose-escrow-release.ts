import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readDriverEscrow } from "../../../../escrow/read";
import { cents } from "../../../../rules-engine";
import { escrowReleaseLimit } from "../../limits";
import { defineTool, type GatewayRef } from "../../types";
import { dateField, idField } from "../../validate";
import { OPERATOR } from "../shared";

// Propose sending a terminated driver's escrow balance back to the driver, for a person to
// approve. The limit asks the whole release gate and the driver's facts as of now and refuses
// any amount but the exact balance; nothing is sent by this call. Only the approval's executor
// (src/lib/escrow/execute.ts, which agent code cannot reach) reserves the ledger row and makes the
// one test-mode payout.

export const proposeEscrowRelease = defineTool({
  name: "propose_escrow_release",
  description:
    "Propose returning a terminated driver's escrow balance to the driver, for a person to " +
    "approve. Nothing is sent by this call. Read get_escrow_statement first, then propose exactly " +
    "the balance in integer cents, with balanceAsOf the statement's asOf date (today). A refusal " +
    "returns a category; tell the person what it names instead of changing the amount.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the escrow release",
  enabled: () => flags.escrowRelease.enabled,
  args: z.strictObject({
    driverId: idField(),
    amountCents: z.int().positive().max(999_999_999),
    balanceAsOf: dateField(),
  }),
  refs: (a): GatewayRef[] => [{ table: "drivers", id: a.driverId }],
  limit: (q, ctx, a) => escrowReleaseLimit(q, ctx, a),
  run: async (q, _ctx, a, extras) => {
    if (!flags.escrowRelease.enabled) throw new Error("escrow releases are switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The driver again in this call's own transaction, for the card's words; the executor checks
    // the balance again at approval.
    const driver = await readDriverEscrow(q, a.driverId);
    if (!driver || driver.balanceCents !== a.amountCents) throw new Error("the escrow balance changed after its limit");
    const draft = {
      kind: "escrow_release" as const,
      subjectTable: "drivers" as const,
      subjectId: a.driverId,
      amountCents: cents(a.amountCents),
      args: { driverId: a.driverId, amountCents: a.amountCents, balanceAsOf: a.balanceAsOf },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: limit.sources,
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        driverId: a.driverId,
        amountCents: draft.amountCents,
        balanceAsOf: a.balanceAsOf,
        limitCents: draft.limitCents,
        note:
          `Would release ${a.amountCents} cents to driver ${driver.code} once a person approves; ` +
          "nothing is sent by this call.",
      },
      draft,
    };
  },
});
