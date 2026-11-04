import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readCheckInput, readReceivablesInput, readRowsWhereId, readTenant } from "../../../../data/read";
import { findPaymentOnWrongInvoice, runAllChecks } from "../../../../rules-engine";
import { runFuelChecks } from "../../../../rules-engine/fuel";
import { demoTemplateFor } from "../../../../seed/carriers";
import { findingInWeek } from "../../../../sweep/plan";
import { isWithin, localDateOf, type Period } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const runChecks = defineTool({
  name: "run_checks",
  description:
    "Run the rules engine's pay and receivables checks over the carrier's records and list what " +
    "they find, optionally only findings about one driver. Each finding has a check name, a " +
    "category, an amount in integer cents when there is one, and the records behind it. With " +
    "periodId it lists what the pay check lists for that week: only the pay findings whose " +
    "record at fault falls in the week, under the week's pay rules. An open week also lists the " +
    "over-limit balance (what a driver owes now) and the payment findings as of its last day; a " +
    "week no longer open lists neither, since they cannot be read as of a past day. The fuel " +
    "findings are left out. A paystub held back for a person is not a " +
    "finding here: get_settlements shows those. Without it the pay findings cover every week. " +
    "For who has a problem on one week's paystub, pass that week's periodId.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Running the pay checks",
  args: z.strictObject({ driverId: idField().optional(), periodId: idField().optional() }),
  refs: (a): GatewayRef[] => [
    ...(a.driverId ? [{ table: "drivers" as const, id: a.driverId }] : []),
    ...(a.periodId ? [{ table: "settlement_periods" as const, id: a.periodId }] : []),
  ],
  run: async (q, ctx, a) => {
    const asOf = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    // One week, as the pay check reads it (sweep findPhase): the week's own pay rules version,
    // only the pay findings whose record at fault falls in the week (findingInWeek), and the
    // payment findings as of the week's last day. The ref check already proved the week is this
    // carrier's.
    let week: Period | null = null;
    let open = true;
    if (a.periodId) {
      const [row] = await readRowsWhereId(q, "settlement_periods", "id", a.periodId);
      if (!row) throw new Error("period vanished after the ref check");
      week = { start: row.period_start, end: row.period_end };
      open = row.status === "open";
    }
    const input = await readCheckInput(q, week?.start);
    // The over-limit finding is what the driver owes now, so it belongs to the open week only (a
    // paid week never had it), as the pay check runs only on an open week.
    // An advance over its load's cap belongs to the week its load was delivered in (the pay check's
    // filter gives it no day, so it would drop it).
    const overCapInWeek = (f: { check: string; sources: { table: string; id: string }[] }, w: Period) => {
      const at = f.sources[0];
      const day = at?.table === "loads" ? input.loads.find((l) => l.id === at.id)?.deliveredOn : undefined;
      return f.check === "advance_over_load_cap" && typeof day === "string" && isWithin(day, w);
    };
    const pay = runAllChecks(input).filter(
      (f) =>
        week === null ||
        ((open || f.check !== "over_advance_limit") && (findingInWeek(f, input, week) || overCapInWeek(f, week))),
    );
    // The payments read today cannot be wound back to a past week's end, so a week that is no
    // longer open lists no payment findings.
    const receivables = week === null || open ? findPaymentOnWrongInvoice(await readReceivablesInput(q, week?.end ?? asOf)) : [];
    const findings = [...pay, ...receivables];
    const rows: Record<string, unknown>[] = findings
      .filter((f) => !a.driverId || f.driverId === a.driverId)
      .map((f) => ({
        check: f.check,
        category: f.category,
        driverId: f.driverId ?? null,
        amountCents: f.amountCents ?? null,
        sources: f.sources,
      }));
    // The fuel checks join the list only while their switch is on, and only for the demo carriers
    // (they list fill-ups from one shared start date, the first day of the seeded demo weeks), with
    // the engine's signed suggested correction (null when it suggests none). The description stays
    // the same either way.
    // The pay check lists no fuel findings, so a week's list leaves them out too.
    if (week === null && flags.fuelAnomalyEnabled && demoTemplateFor(await readTenant(q))) {
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
