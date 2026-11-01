import { SYNTHETIC_LABELS, SYNTHETIC_RENAMED } from "../../tms/status";
import { parseInstant } from "../../time/local-date";
import type { DemoFaults } from "./faults";
import { SKEW_MS } from "./synthetic";
import type { TmsHistoryRow, TmsListRow, TmsLoadRecord, TwoClocks } from "./types";

// MOCK-TMS: the demo fault switches as the sample dispatch system serves them (MOCK_FAULTS in
// faults.ts), each a pure change to what mock.ts read from the store, so the store itself never
// changes. The other three switches change what the feed itself records (a status, a time, a
// rate); on the sample system a person does those there instead, so it ignores them.
//   stale_list_rows: a list row shows the status and time of the latest status change at or
//     before 30 minutes before the clock (the current row when there is none).
//   hard_delete: the load in transit with the lowest reference is not found (picked in mock.ts).
//   clock_skew: every delivery's UTC field is two days before its local field.
//   server_errors: every third load read in one source throws server_error (in mock.ts).
//   history_page_cut: history comes CUT_PAGE rows a page, repeating the last row (historyPage).
//   relabeled_status: In Transit is shown as Rolling.

const IN_TRANSIT = SYNTHETIC_LABELS.in_transit;
const DELIVERED = SYNTHETIC_LABELS.delivered;

const iso = (n: number) => new Date(n).toISOString();

export function relabeled(label: string, faults: DemoFaults): string {
  return faults.relabeled_status && label === IN_TRANSIT ? SYNTHETIC_RENAMED.label : label;
}

function skewed(c: TwoClocks | null, faults: DemoFaults): TwoClocks | null {
  if (c === null || !faults.clock_skew || c.utc === null) return c;
  return { utc: iso(parseInstant(c.utc) - SKEW_MS), local: c.local };
}

export function faultedRecord(r: TmsLoadRecord, faults: DemoFaults): TmsLoadRecord {
  return {
    ...r,
    statusLabel: relabeled(r.statusLabel, faults),
    deliveries: r.deliveries.map((s) => ({ ...s, completed: skewed(s.completed, faults) })),
    delivered: skewed(r.delivered, faults),
    lastDeliveryCompleted: skewed(r.lastDeliveryCompleted, faults),
  };
}

export function faultedHistory(rows: readonly TmsHistoryRow[], faults: DemoFaults): TmsHistoryRow[] {
  return rows.map((h) => {
    if (h.field !== "status") return h;
    const at = h.newValue === DELIVERED ? (skewed(h.at, faults) ?? h.at) : h.at;
    return {
      ...h,
      newValue: h.newValue === null ? null : relabeled(h.newValue, faults),
      previousValue: h.previousValue === null ? null : relabeled(h.previousValue, faults),
      at,
    };
  });
}

// `stale` is the load's latest status change at or before the stale cutoff, or null.
export function faultedListRow(row: TmsListRow, stale: { label: string; at: string } | null, faults: DemoFaults): TmsListRow {
  const base = faults.stale_list_rows && stale !== null ? { ...row, statusLabel: stale.label, updatedAt: stale.at } : row;
  return { ...base, statusLabel: relabeled(base.statusLabel, faults) };
}

// hard_delete's pick: the lowest reference among the loads in transit, compared whole.
export function deletedReference(inTransit: readonly string[], faults: DemoFaults): string | null {
  if (!faults.hard_delete || inTransit.length === 0) return null;
  return [...inTransit].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
}
