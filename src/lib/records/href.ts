// The one place a source record becomes a link. The record pages arrive with the items that own
// them (settlements, advances, invoices); until then no live screen renders a record link.
// The list mirrors the rules engine's TABLES; when the engine is on main, import it from there.

export const RECORD_TABLES = [
  "customers",
  "drivers",
  "loads",
  "load_state_miles",
  "load_accessorials",
  "driver_days",
  "fuel_purchases",
  "pay_configs",
  "deduction_schedules",
  "pay_items",
  "advances",
  "settlement_periods",
  "settlements",
  "settlement_lines",
  "invoices",
] as const;

export type RecordTable = (typeof RECORD_TABLES)[number];

// Structural on purpose: the engine's SourceRef ({ table: TableName; id }) fits it as is.
export type SourceRef = { table: string; id: string };

export type HrefFor = (ref: SourceRef) => string;

export function recordHref(ref: SourceRef): string {
  if (!(RECORD_TABLES as readonly string[]).includes(ref.table)) {
    throw new RangeError("not a record table");
  }
  if (typeof ref.id !== "string" || ref.id.length === 0) throw new RangeError("a record id is missing");
  return `/records/${ref.table}/${encodeURIComponent(ref.id)}`;
}
