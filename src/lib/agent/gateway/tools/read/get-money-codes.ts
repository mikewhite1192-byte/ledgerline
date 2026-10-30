import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { listMoneyCodes } from "../../../../money-codes/read";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// The money codes asked for, newest first, optionally one driver's or one load's. Never the code,
// its last four digits or the provider's reference: the agent needs only what was asked, for how
// much, and where it stands.

export const getMoneyCodes = defineTool({
  name: "get_money_codes",
  description:
    "List money codes, newest first, optionally for one driver or one load: purpose, amount in " +
    "integer cents, status (issuing, issued, failed, unknown, voided), and when it was asked for, " +
    "issued and expires. The code itself is never returned.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading money codes",
  enabled: () => flags.moneyCodes.enabled,
  args: z.strictObject({
    driverId: idField().optional(),
    loadId: idField().optional(),
    limit: z.int().min(1).max(20).optional(),
  }),
  refs: (a): GatewayRef[] => [
    ...(a.driverId ? [{ table: "drivers" as const, id: a.driverId }] : []),
    ...(a.loadId ? [{ table: "loads" as const, id: a.loadId }] : []),
  ],
  run: async (q, _ctx, a) => {
    if (!flags.moneyCodes.enabled) throw new Error("money codes are switched off");
    const rows = await listMoneyCodes(q, {
      driverId: a.driverId ?? null,
      loadId: a.loadId ?? null,
      limit: a.limit ?? 10,
    });
    return {
      result: {
        rows: rows.map((c) => ({
          id: c.id,
          driverId: c.driverId,
          driverCode: c.driverCode,
          loadId: c.loadId,
          loadNumber: c.loadNumber,
          purpose: c.purpose,
          amountCents: c.amountCents,
          source: c.sourceKind,
          status: c.status,
          proposalId: c.proposalId,
          askedAt: c.createdAt,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
        })),
      },
    };
  },
});
