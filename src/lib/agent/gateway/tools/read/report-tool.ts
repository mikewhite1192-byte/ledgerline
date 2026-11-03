import type { z } from "zod";
import { REPORT_ARGS, ReportArgsError, type ReportRequest } from "../../../../reports/args";
import { computeReport } from "../../../../reports/run";
import { ReportsOffError, reportSwitchOn } from "../../../../reports/switch";
import { REPORT_ROW_CAP, reportToolName, type ReportName, type ReportResult } from "../../../../reports/types";
import { defineTool, type AgentRole, type AnyToolDef, type GatewayRef } from "../../types";
import { OPERATOR } from "../shared";

// The report tools share one shape: the model picks the report and fills its typed args;
// the code reads the records and the rules engine computes every number. The result carries at
// most 50 rows (the download has them all), and fewer when 50 would not fit the gateway's
// character cap, so the gateway never cuts it and rowsTotal stays the report's own row count.

// The gateway's MAX_RESULT_CHARS (a test holds them equal; the gateway index imports this file).
export const REPORT_RESULT_CHARS = 8_000;

type ReportArgsShape = Record<string, string | undefined>;

function refsOf(a: ReportArgsShape): GatewayRef[] {
  const out: GatewayRef[] = [];
  if (a.driverId) out.push({ table: "drivers", id: a.driverId });
  if (a.customerId) out.push({ table: "customers", id: a.customerId });
  return out;
}

// The most leading rows (up to 50) whose result fits the cap, with the totals over every row.
export function fitResult(result: ReportResult): Record<string, unknown> {
  const shape = (n: number) => ({
    ...result,
    rows: result.rows.slice(0, n),
    truncated: result.truncated || n < result.rows.length,
    rowsShown: n,
  });
  let lo = 0;
  let hi = Math.min(result.rows.length, REPORT_ROW_CAP);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(shape(mid)).length <= REPORT_RESULT_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return shape(lo);
}

// Most reports are the operator's; a report the auditor may also read passes its roles.
export function reportTool(
  name: ReportName,
  text: { description: string; label: string },
  roles: readonly AgentRole[] = OPERATOR,
): AnyToolDef {
  return defineTool({
    name: reportToolName(name),
    description: text.description,
    tier: "read",
    roles,
    label: text.label,
    // Each report's own strict schema; its fields are all optional or required strings.
    args: REPORT_ARGS[name] as z.ZodType<ReportArgsShape>,
    refs: refsOf,
    // Read on every offer and call, so the offer list, the disabled block and toolNamed agree.
    enabled: () => reportSwitchOn(name),
    run: async (q, ctx, a) => {
      if (!reportSwitchOn(name)) throw new ReportsOffError();
      const request = { name, args: a } as ReportRequest;
      try {
        return { result: fitResult(await computeReport(q, request, { now: ctx.now, timeZone: ctx.timeZone })) };
      } catch (err) {
        // Args the report refused against today, before any read: the same answer the schema's
        // own refusal gives, a field path and a code, never the text.
        if (err instanceof ReportArgsError) {
          return { result: { error: "invalid_args", fieldErrors: [{ path: err.path, code: "custom" }] } };
        }
        throw err;
      }
    },
  });
}
