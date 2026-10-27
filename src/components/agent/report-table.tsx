import type { ReactNode } from "react";
import type { Column, DataTableProps } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { formatLocalDate, formatPeriod } from "@/lib/format/dates";
import { hrefOrNull, recordHref, type HrefFor } from "@/lib/records/href";
import { isLocalDate } from "@/lib/time/local-date";
import {
  EMPTY_TEXT,
  isRefCell,
  isReportName,
  REPORT_COLUMNS,
  REPORT_TITLES,
  type ReportCell,
  type ReportColumn,
  type ReportName,
  type ReportResult,
} from "@/lib/reports/types";

// A report as a chat table. The numbers come from the report route exactly as the engine
// computed them; this file only formats them: cents as dollars, basis points as a percent,
// dates in words, each record as a link to its page. Totals and subtotals are rows at the end.

export type ReportLoad =
  | { state: "loading" }
  | { state: "error"; category: "forbidden" | "unreadable" }
  | { state: "ready"; result: ReportResult };

type Line = { key: string; kind: "row" | "subtotal" | "total"; cells: Record<string, ReportCell> };

const NUMERIC = new Set<ReportColumn["kind"]>(["cents", "int", "pct"]);

// 1234 basis points is "12.34%", from the integer, with no floating point.
export function formatBps(bps: number): string {
  const abs = Math.abs(bps);
  return `${bps < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

function Unknown() {
  return <span className="text-muted-foreground">Not known</span>;
}

function cellOf(column: ReportColumn, value: ReportCell, hrefFor: HrefFor): ReactNode {
  if (value === null || value === undefined) return column.kind === "text" ? null : <Unknown />;
  switch (column.kind) {
    case "ref": {
      if (!isRefCell(value)) return null;
      const href = hrefOrNull(hrefFor, value);
      return href ? (
        <a href={href} className="text-link underline-offset-4 hover:underline">
          {value.label}
        </a>
      ) : (
        value.label
      );
    }
    case "cents":
      return typeof value === "number" ? <Money cents={value} /> : null;
    case "int":
      return typeof value === "number" ? <span className="tabular-nums">{value}</span> : null;
    case "pct":
      return typeof value === "number" ? <span className="tabular-nums">{formatBps(value)}</span> : null;
    case "date":
      // A malformed date shows as not known instead of breaking the whole chat.
      if (typeof value !== "string") return null;
      return isLocalDate(value) ? formatLocalDate(value) : <Unknown />;
    case "text":
      return typeof value === "string" ? value : null;
  }
}

// The aging uses today's open balances whatever date it ages them on, so its caption says so
// instead of reading as the position on that date.
function captionOf(result: ReportResult): string {
  const when = result.period
    ? formatPeriod(result.period.start, result.period.end)
    : result.report === "ar_aging"
      ? `open balances today, by how late they are as of ${formatLocalDate(result.asOf)}`
      : `as of ${formatLocalDate(result.asOf)}`;
  const cut = result.truncated
    ? `. Showing the first ${result.rows.length} of ${result.rowsTotal} rows; the CSV has them all`
    : "";
  return `${result.title}, ${when}${cut}`;
}

function linesOf(result: ReportResult): Line[] {
  const lines: Line[] = result.rows.map((cells, i) => ({ key: `row:${i}`, kind: "row", cells }));
  for (const [i, s] of (result.subtotals ?? []).entries()) {
    lines.push({ key: `subtotal:${i}`, kind: "subtotal", cells: { ...s.totals, __label: s.label } });
  }
  if (result.totals) lines.push({ key: "total", kind: "total", cells: { ...result.totals, __label: "Total" } });
  return lines;
}

function columnsOf(columns: readonly ReportColumn[], hrefFor: HrefFor): Column<Line>[] {
  return columns.map((c, i) => ({
    key: c.key,
    header: c.header,
    align: NUMERIC.has(c.kind) ? "right" : "left",
    wrap: c.kind === "text" && c.key === "note",
    cell: (line: Line) => {
      if (line.kind === "row") return cellOf(c, line.cells[c.key] ?? null, hrefFor);
      if (i === 0) return <span className="font-semibold text-foreground">{String(line.cells.__label)}</span>;
      const value = line.cells[c.key];
      if (typeof value !== "number") return null;
      return <span className="font-semibold">{cellOf(c, value, hrefFor)}</span>;
    },
  }));
}

// The table part for one report in its current state.
export function reportTable(
  name: ReportName,
  load: ReportLoad,
  hrefFor: HrefFor = recordHref,
): DataTableProps<Line> {
  const base = { rowKey: (l: Line) => l.key, dense: true };
  if (load.state !== "ready") {
    return {
      ...base,
      caption: REPORT_TITLES[name],
      columns: columnsOf(REPORT_COLUMNS[name], hrefFor),
      rows: [],
      state: load.state,
      ...(load.state === "error" ? { error: { category: load.category } } : {}),
    };
  }
  const { result } = load;
  return {
    ...base,
    caption: captionOf(result),
    columns: columnsOf(result.columns, hrefFor),
    rows: result.rows.length > 0 ? linesOf(result) : [],
    state: result.rows.length > 0 ? "ready" : "empty",
    empty: EMPTY_TEXT[result.emptyReason ?? "no_rows"],
  };
}

// A report route body, accepted only when it is the report that was asked for.
export function reportResultOf(name: ReportName, body: unknown): ReportResult | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Partial<ReportResult>;
  if (!isReportName(r.report) || r.report !== name) return null;
  if (!Array.isArray(r.rows) || !Array.isArray(r.columns) || !isLocalDate(r.asOf)) return null;
  if (typeof r.title !== "string" || typeof r.rowsTotal !== "number") return null;
  // The caption formats these dates, so a malformed one is refused here, not thrown at render.
  const p = r.period;
  if (p !== undefined && !(isLocalDate(p?.start) && isLocalDate(p?.end) && p.start <= p.end)) return null;
  return r as ReportResult;
}
