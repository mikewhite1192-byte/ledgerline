// The one place a source record becomes a link. A link goes only to a record that has a page under
// src/app/records/<table>/[id]; every other table the rules engine cites stays plain text, so no
// screen links to a page that is not there.
import { TABLES, type TableName } from "@/lib/rules-engine/types";

// Every table the rules engine cites is a record table, so the two lists cannot drift apart.
export const RECORD_TABLES: readonly TableName[] = TABLES;

// The record tables with a page. href.test.ts checks this list against the page files on disk.
// load_accessorials and settlement_periods are small pages that send the reader on: an extra
// charge to its load's "Extra charges" table, a pay week to its Pay runs view.
export const RECORD_PAGES: readonly TableName[] = [
  "customers",
  "drivers",
  "loads",
  "load_accessorials",
  "driver_days",
  "deduction_schedules",
  "pay_items",
  "advances",
  "settlement_periods",
  "settlements",
  "invoices",
  "customer_payments",
  "vendor_bills",
];

export type RecordTable = TableName;

// Structural on purpose: the engine's SourceRef ({ table: TableName; id }) fits it as is.
export type SourceRef = { table: string; id: string };

export type HrefFor = (ref: SourceRef) => string;

export function recordHref(ref: SourceRef): string {
  if (!(RECORD_TABLES as readonly string[]).includes(ref.table)) {
    throw new RangeError("not a record table");
  }
  if (!(RECORD_PAGES as readonly string[]).includes(ref.table)) {
    throw new RangeError("this record has no page");
  }
  if (typeof ref.id !== "string" || ref.id.length === 0) throw new RangeError("a record id is missing");
  return `/records/${ref.table}/${encodeURIComponent(ref.id)}`;
}

// For rendering: a ref the link rules refuse comes back as null, so the caller shows its label as
// plain text instead of taking the whole page down. Only that refusal (a RangeError) is caught.
export function hrefOrNull(hrefFor: HrefFor, ref: SourceRef): string | null {
  try {
    return hrefFor(ref);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
