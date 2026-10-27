// The one place a source record becomes a link. The record pages arrive with the items that own
// them (settlements, advances, invoices); until then no live screen renders a record link.
import { TABLES, type TableName } from "@/lib/rules-engine/types";

// Every table the rules engine cites is a record table, so the two lists cannot drift apart.
export const RECORD_TABLES: readonly TableName[] = TABLES;

export type RecordTable = TableName;

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
