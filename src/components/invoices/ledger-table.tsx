import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { formatInstant } from "@/lib/format/dates";
import { codeToWords } from "@/lib/format/labels";
import type { LedgerRow } from "@/lib/invoices/views";

// The record's ledger rows: every attempt to post it, with its state and why it failed, by
// category only.
export function LedgerTable({ rows, timezone }: { rows: LedgerRow[]; timezone: string }) {
  return (
    <DataTable
      caption="QuickBooks posting attempts"
      rows={rows}
      rowKey={(r) => r.id}
      empty={{ title: "Not sent to QuickBooks yet", body: "Each attempt to post shows here with its outcome." }}
      columns={[
        { key: "attempt", header: "Attempt", cell: (r) => `#${r.attempt}` },
        { key: "state", header: "State", cell: (r) => <StatusBadge status={r.state} /> },
        { key: "amount", header: "Amount", align: "right", cell: (r) => <Money cents={r.amountCents} tone="plain" /> },
        { key: "why", header: "Why", cell: (r) => (r.failureCategory ? codeToWords(r.failureCategory) : "") },
        { key: "at", header: "Reserved", cell: (r) => formatInstant(r.createdAt, timezone) },
      ]}
    />
  );
}
