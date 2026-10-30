import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readEscrowStatement } from "../../../../escrow/statement";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// One driver's final escrow statement: zero at the first active day, one line per paid week that
// withheld or charged escrow, one per release sent, the closing sum and the stored balance beside
// it. A difference is reported as matches: false, never corrected. Reads only. Behind the escrow
// release switch, read on every offer and every call, and again here.

// The most lines one answer carries; the totals always cover every line.
export const STATEMENT_LINES_SHOWN = 60;

export const getEscrowStatement = defineTool({
  name: "get_escrow_statement",
  description:
    "Read one driver's escrow statement: opening balance 0, each paid week's escrow withheld and " +
    "charged, each release sent, the closing sum and the stored balance, all in integer cents, " +
    "and matches (whether the two agree). terminated says whether the last active day has passed. " +
    "Propose a release only for a terminated driver whose statement matches, for exactly the balance.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the escrow statement",
  enabled: () => flags.escrowRelease.enabled,
  args: z.strictObject({ driverId: idField() }),
  refs: (a): GatewayRef[] => [{ table: "drivers", id: a.driverId }],
  run: async (q, ctx, a) => {
    if (!flags.escrowRelease.enabled) throw new Error("escrow releases are switched off");
    const s = await readEscrowStatement(q, a.driverId, ctx.now.toISOString(), ctx.timeZone);
    if (!s) return { result: { found: false } };
    return {
      result: {
        found: true,
        driverId: s.driverId,
        driverCode: s.driverCode,
        firstActiveDay: s.activeFrom,
        lastActiveDay: s.activeTo,
        terminated: s.terminated,
        asOf: s.asOf,
        openingCents: s.openingCents,
        withheldCents: s.withheldCents,
        chargesCents: s.chargesCents,
        releasedCents: s.releasedCents,
        closingCents: s.closingCents,
        balanceCents: s.balanceCents,
        matches: s.matches,
        openRelease: s.openRelease,
        linesTotal: s.lines.length,
        lines: s.lines.slice(-STATEMENT_LINES_SHOWN),
      },
    };
  },
});
