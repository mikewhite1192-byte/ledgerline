import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readCheckInput, readReceivablesInput } from "../../../../data/read";
import { findPaymentOnWrongInvoice, runAllChecks } from "../../../../rules-engine";
import { runFuelChecks } from "../../../../rules-engine/fuel";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const runChecks = defineTool({
  name: "run_checks",
  description:
    "Run the rules engine's pay and receivables checks over the carrier's records and list what " +
    "they find, optionally only findings about one driver. Each finding has a check name, a " +
    "category, an amount in integer cents when there is one, and the records behind it.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Running the pay checks",
  args: z.strictObject({ driverId: idField().optional() }),
  refs: (a): GatewayRef[] => (a.driverId ? [{ table: "drivers", id: a.driverId }] : []),
  run: async (q, ctx, a) => {
    const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const input = await readCheckInput(q);
    const findings = [...runAllChecks(input), ...findPaymentOnWrongInvoice(await readReceivablesInput(q, asOf))];
    const rows: Record<string, unknown>[] = findings
      .filter((f) => !a.driverId || f.driverId === a.driverId)
      .map((f) => ({
        check: f.check,
        category: f.category,
        driverId: f.driverId ?? null,
        amountCents: f.amountCents ?? null,
        sources: f.sources,
      }));
    // The fuel checks join the list only while their switch is on, with the engine's signed
    // suggested correction (null when it suggests none). The description stays the same either way.
    if (flags.fuelAnomalyEnabled) {
      for (const f of runFuelChecks(input, flags.fuelAnomalyLimits)) {
        if (a.driverId && f.driverId !== a.driverId) continue;
        rows.push({
          check: f.check,
          category: f.category,
          driverId: f.driverId,
          amountCents: f.amountCents,
          sources: f.sources,
          suggestedCents: f.suggestedCents,
        });
      }
    }
    return { result: { asOf, rows } };
  },
});
