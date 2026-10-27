import { argStrings, parseReportArgs } from "../../reports/args";
import { reportOfTool, type ReportName } from "../../reports/types";

// Which report an allowed tool call built, and the args it was built with, so the chat can show
// the table again from the download route. Only the report name and its typed args (dates and
// ids) leave here: the turn store keeps ids, counts and categories, never a tool's result.

export type ReportRef = { name: ReportName; args: Record<string, string> };

export function reportRefOf(tool: string, result: Record<string, unknown>): ReportRef | null {
  const name = reportOfTool(tool);
  if (!name || result.report !== name) return null;
  const args = result.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  // The same strict schema the tool parsed with: anything else is not recorded.
  const parsed = parseReportArgs(name, args);
  return parsed ? { name, args: argStrings(parsed.args) } : null;
}
