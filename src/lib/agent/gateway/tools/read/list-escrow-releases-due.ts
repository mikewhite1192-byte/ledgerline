import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { DUE_LIST_MAX, listReleasesDue } from "../../../../escrow/due";
import { localDateOf } from "../../../../time/local-date";
import { defineTool } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// The drivers due for an escrow release: terminated at least ninety days ago on the carrier's
// local dates, still holding a balance, with no release being sent, sent or not known yet. A read
// only: nothing is emailed, texted or sent, so a driver terminated long ago is listed and nothing
// happens until a person approves a release. Drivers by id and code only. Behind the escrow
// release switch, read on every offer and every call, and again here.

export const listEscrowReleasesDue = defineTool({
  name: "list_escrow_releases_due",
  description:
    "List the drivers whose escrow is due back: last active day at least 90 days ago on the " +
    "carrier's dates, a balance above zero in integer cents, and no release already started. " +
    "Oldest termination first, at most 50. Read get_escrow_statement before proposing a release.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading escrow releases due",
  enabled: () => flags.escrowRelease.enabled,
  args: z.strictObject({}),
  refs: () => [],
  run: async (q, ctx) => {
    if (!flags.escrowRelease.enabled) throw new Error("escrow releases are switched off");
    const due = await listReleasesDue(q, localDateOf(ctx.now.toISOString(), ctx.timeZone));
    return {
      result: {
        asOf: due.asOf,
        max: DUE_LIST_MAX,
        truncated: due.truncated,
        drivers: due.drivers.map((d) => ({
          driverId: d.driverId,
          driverCode: d.driverCode,
          lastActiveDay: d.activeTo,
          daysSince: d.daysSince,
          balanceCents: d.balanceCents,
        })),
      },
    };
  },
});
