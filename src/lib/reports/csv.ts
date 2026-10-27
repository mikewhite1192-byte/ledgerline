import { isRefCell, type ReportCell, type ReportColumn, type ReportResult } from "./types";

// A report as CSV (RFC 4180: comma separated, CRLF line ends, a field quoted when it holds a
// comma, a quote or a line break, quotes doubled). Every row, then subtotal and total rows.
// Cents are written as dollars with two decimals from the integer (123456 is 1234.56), basis
// points as a percent with two decimals, dates as YYYY-MM-DD, a record as its label plus its id.
//
// Spreadsheet formula guard: a text field (a header, a label, a name, a note) that starts with
// =, +, -, @, a tab or a carriage return gets a leading single quote, so a spreadsheet shows it
// as text instead of running it. Numbers written here never get one: they match a strict number
// pattern, so a negative amount stays a number.

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?%?$/;

export function guardText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function fixed2(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error("a report number is not a whole number");
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function numberField(text: string): string {
  if (!NUMBER.test(text)) throw new Error("a report number did not format as a number");
  return text;
}

// The header row: a record column becomes two, its label and its id.
function headerOf(columns: readonly ReportColumn[]): string[] {
  return columns.flatMap((c) => (c.kind === "ref" ? [c.header, `${c.header} id`] : [c.header]));
}

function fieldsOf(column: ReportColumn, value: ReportCell | undefined): string[] {
  if (column.kind === "ref") {
    return isRefCell(value) ? [guardText(value.label), guardText(value.id)] : ["", ""];
  }
  if (value === null || value === undefined) return [""];
  if (typeof value === "number") {
    if (column.kind === "cents") return [numberField(fixed2(value))];
    if (column.kind === "pct") return [numberField(`${fixed2(value)}%`)];
    if (column.kind === "int") return [numberField(String(value))];
  }
  return [guardText(String(value))];
}

// A subtotal or total row: its label in the first field, its sums under their columns.
function sumRow(columns: readonly ReportColumn[], label: string, totals: Record<string, number>): string[] {
  const out: string[] = [];
  columns.forEach((c, i) => {
    const width = c.kind === "ref" ? 2 : 1;
    if (i === 0) {
      out.push(guardText(label));
      if (width === 2) out.push("");
      return;
    }
    const value = Object.hasOwn(totals, c.key) ? totals[c.key] : null;
    out.push(...(value === null ? Array(width).fill("") : fieldsOf(c, value)));
  });
  return out;
}

export function reportCsv(result: ReportResult): string {
  const lines: string[][] = [headerOf(result.columns).map(guardText)];
  for (const row of result.rows) lines.push(result.columns.flatMap((c) => fieldsOf(c, row[c.key])));
  if (result.rows.length > 0) {
    for (const s of result.subtotals ?? []) lines.push(sumRow(result.columns, s.label, s.totals));
    if (result.totals) lines.push(sumRow(result.columns, "Total", result.totals));
  }
  return lines.map((fields) => fields.map(quote).join(",")).join("\r\n") + "\r\n";
}
