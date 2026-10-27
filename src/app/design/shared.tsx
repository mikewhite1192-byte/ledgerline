// Pieces both the server page and the client demos use. No "use client": functions defined here
// run wherever they are called.
import Link from "next/link";
import type { Column } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { formatLocalDate } from "@/lib/format/dates";
import type { HrefFor } from "@/lib/records/href";
import type { LoadRow } from "./sample-data";

// Each mode's column has its own copy of the source records, so its links carry its prefix.
export function anchorFor(prefix: string): HrefFor {
  return (ref) => `#${prefix}source-${ref.table}-${ref.id}`;
}

export function loadColumns(hrefFor: HrefFor): Column<LoadRow>[] {
  return [
    {
      key: "id",
      header: "Load",
      cell: (r) => (
        <Link href={hrefFor({ table: "loads", id: r.id })} className="font-medium text-link underline-offset-4 hover:underline">
          {r.id}
        </Link>
      ),
    },
    { key: "lane", header: "Lane", wrap: true, cell: (r) => r.lane },
    { key: "delivered", header: "Delivered", cell: (r) => <span className="whitespace-nowrap">{formatLocalDate(r.delivered)}</span> },
    { key: "miles", header: "Miles", align: "right", cell: (r) => r.miles.toLocaleString("en-US") },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "pay", header: "Driver pay", align: "right", cell: (r) => <Money cents={r.payCents} /> },
  ];
}
