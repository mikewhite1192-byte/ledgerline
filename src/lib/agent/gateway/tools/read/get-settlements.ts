import { z } from "zod";
import { readDueWeekAndPay, readRowsWhereId } from "../../../../data/read";
import { nameOf, readPayRunDrivers, readSettlementRows } from "../../../../settlements/list";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// The most drivers an open week's list carries: about 100 characters each, so 40 with the rest of
// the result stays well under the gateway's 8,000 (MAX_RESULT_CHARS), which would otherwise drop
// the whole result. payableDriversTotal says how many there are.
export const PAYABLE_DRIVERS_CAP = 40;

// The most characters of JSON the list may take, whatever the names' lengths: about 5,000 of the
// gateway's 8,000, leaving the rest for readNext and the week (a test holds the whole result
// under the cap with long names). The list stops at the driver that would cross it.
export const PAYABLE_DRIVERS_CHARS = 5_000;

type PayableDriver = { driverId: string; driverCode: string; driverName: string };

// The payable drivers in order, at most the cap and at most the character budget as JSON.
export function payableDriversList(
  payable: readonly { id: string; code: string; first_name: string; last_name: string }[],
): PayableDriver[] {
  const out: PayableDriver[] = [];
  // The empty list's brackets; each entry adds itself and, after the first, a comma.
  let chars = 2;
  for (const d of payable.slice(0, PAYABLE_DRIVERS_CAP)) {
    const entry = { driverId: d.id, driverCode: d.code, driverName: nameOf(d.first_name, d.last_name) };
    const size = JSON.stringify(entry).length + (out.length > 0 ? 1 : 0);
    if (chars + size > PAYABLE_DRIVERS_CHARS) break;
    chars += size;
    out.push(entry);
  }
  return out;
}

// What to read next on an open week with pay and no paystubs yet, as the result says it.
export const READ_NEXT =
  "No paystubs yet does not mean no problems or no pay: run_checks with this periodId lists " +
  "this week's pay problems now, as the pay check lists them (call it next unless it already " +
  "came back), and explain_paystub with this " +
  "periodId and a driver's id (from run_checks, or from get_settlements for a week that has paystubs) previews that driver's pay for " +
  "this week, computed by the rules engine. A question about one driver takes that driver's " +
  "driverId from payableDrivers here to explain_paystub. Answer from those two: report_driver_pay_summary " +
  "has no rows for this week and report_driver_insights ranks drivers, so neither answers " +
  "this week's problems or one driver's pay.";

export const getSettlements = defineTool({
  name: "get_settlements",
  description:
    "List one pay week's paystubs (the week paid next, the one the pay check reads, unless " +
    "periodId is given), in driver order: each one's driver, gross, deductions and net in " +
    "integer cents, status, the exception categories on its approval card, the auditor's " +
    "verdict, whether it is clean for Approve all clean, and parkedReason when it no longer " +
    "matches its records. For who has a problem on this week's paystub or why a driver's pay " +
    "is short this week, send run_checks with the week paid next's periodId (the state summary " +
    "names it) in the same response as this call, so both come back together; for a week named " +
    "by periodId, send run_checks with that same periodId. For one driver whose driverId you " +
    "already have (from find_driver), send explain_paystub with that periodId and driverId in " +
    "that same response too: it previews the driver's pay for a week with no paystubs yet. noPaystubsYet " +
    "true means only that this open week has no paystubs " +
    "yet, never no problems or no pay: for who has a problem call run_checks with this " +
    "periodId, and for one driver's pay call explain_paystub with this periodId and the " +
    "driver's id (from run_checks, or from get_settlements for a week that has paystubs), then answer from what they find. " +
    "Such a week lists payableDrivers, the drivers Run the week would draft a paystub for (driverId, " +
    "driverCode, driverName; at most 40, fewer when the names are long, payableDriversTotal counting them all): a question about " +
    "one driver takes that driver's driverId from it to explain_paystub. " +
    "Never call report_driver_pay_summary or report_driver_insights for that week's problems " +
    "or one driver's pay: the summary has no rows before paystubs and the ranking explains no " +
    "one's pay. With runTheWeek true it is the week paid next and has pay: say " +
    "plainly that pressing " +
    "Run the week on the Pay page runs it and makes paystubs for the drivers with " +
    "payable work; never say it was not run. With noPayYet true it has no pay yet: say so and " +
    "never point at Run the week. With waitsForWeekPaidNext true its pay runs after the week " +
    "paid next. weekPaidNext, when given, names the week paid next: say its dates. This only " +
    "reads; explain_paystub explains one paystub line by line.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading this week's paystubs",
  args: z.strictObject({ periodId: idField().optional() }),
  refs: (a): GatewayRef[] => (a.periodId ? [{ table: "settlement_periods", id: a.periodId }] : []),
  run: async (q, _ctx, a) => {
    let period: { id: string; start: string; end: string; status: string } | null;
    // The week paid next and the pay check, read once: always for the default week, and for a
    // named week only when it is open with no paystubs (the hint below needs it).
    let weeks: Awaited<ReturnType<typeof readDueWeekAndPay>> | null = null;
    if (a.periodId) {
      // The ref check already proved the week is this carrier's; it may be older than the list.
      const [row] = await readRowsWhereId(q, "settlement_periods", "id", a.periodId);
      if (!row) throw new Error("period vanished after the ref check");
      period = { id: row.id, start: row.period_start, end: row.period_end, status: row.status };
    } else {
      // The week paid next (readDueWeek, D-093), the week the pay check and the sweep read: the
      // oldest open week with a paystub or a day that carries pay, else the newest open week.
      weeks = await readDueWeekAndPay(q);
      const due = weeks.due;
      // Status open is right: dueWeek picks only from open weeks.
      period = due ? { id: due.id, start: due.period_start, end: due.period_end, status: "open" } : null;
    }
    if (!period) return { result: { period: null, settlements: [], awaitingAuditor: 0 } };
    const { rows, awaitingAuditor } = await readSettlementRows(q, period.id);
    // An open week with no paystubs yet: not run, or run with no driver to pay. The period
    // records no run, so this says only that none exist yet, never which. Run the week is named
    // only for the week paid next with pay in it; any other empty open week says it has no pay
    // yet, or that its pay runs after the week paid next, and names that week.
    let empty: Record<string, unknown> = {};
    if (rows.length === 0 && period.status === "open") {
      weeks ??= await readDueWeekAndPay(q);
      const due = weeks.due;
      const isDue = due !== null && due.id === period.id;
      const hasPay = weeks.holdsPay(period);
      const next =
        due !== null && !isDue ? { weekPaidNext: { periodId: due.id, start: due.period_start, end: due.period_end } } : {};
      // A week with pay and no paystubs still has problems to find and pay to preview: readNext
      // names the reads that answer from the rules engine now, so an answer never stops at no
      // paystubs. A week with no pay has nothing to preview, so it carries none.
      // The drivers the run would draft for (the run's own statement), so a question about one
      // driver has their id for explain_paystub without another read.
      const payable = hasPay ? await readPayRunDrivers(q, period) : [];
      const drivers = {
        payableDrivers: payableDriversList(payable),
        payableDriversTotal: payable.length,
      };
      empty =
        isDue && hasPay
          ? { noPaystubsYet: true, runTheWeek: true, readNext: READ_NEXT, ...drivers }
          : hasPay
            ? { noPaystubsYet: true, waitsForWeekPaidNext: true, readNext: READ_NEXT, ...drivers, ...next }
            : { noPaystubsYet: true, noPayYet: true, ...next };
    }
    return {
      result: {
        period: { periodId: period.id, start: period.start, end: period.end, status: period.status },
        settlements: rows.map((r) => ({
          settlementId: r.id,
          driverId: r.driverId,
          driverCode: r.driverCode,
          driverName: r.driverName,
          grossCents: r.grossCents,
          deductionsCents: r.deductionsCents,
          netCents: r.netCents,
          status: r.status,
          exceptions: r.exceptions,
          auditorVerdict: r.auditor,
          auditorAgrees: r.auditorAgrees,
          clean: r.clean,
          parkedReason: r.parkedReason,
        })),
        // Cards still waiting for the auditor: none of them is clean yet.
        awaitingAuditor,
        ...empty,
      },
    };
  },
});
