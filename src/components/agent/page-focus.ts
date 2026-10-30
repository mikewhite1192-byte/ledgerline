import type { FocusTable } from "@/lib/agent/gateway/focus";
import { formatLocalDate } from "@/lib/format/dates";

// The one record a signed-in page is about, declared by the page from the id it already read under
// the carrier, with a short label it already shows. The agent panel shows the label in its chip
// and sends only {table, id}; the server checks the id and names the record itself. List pages
// and Home declare none, and a route path alone is never sent.
export type PageFocus = { table: FocusTable; id: string; label: string };

// "week ending Oct 25, 2026": a pay week by its last day, in words.
export function weekEnding(periodEnd: string): string {
  return `week ending ${formatLocalDate(periodEnd)}`;
}
