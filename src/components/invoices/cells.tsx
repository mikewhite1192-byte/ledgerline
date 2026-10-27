import Link from "next/link";
import type { ReactNode } from "react";
import { Term } from "@/components/app/term";
import { formatLocalDate } from "@/lib/format/dates";
import type { TermId } from "@/lib/format/terms";
import { recordHref } from "@/lib/records/href";

// Small pieces the invoice and receivables pages share.

export function RecordLink({ table, id, children }: { table: string; id: string; children: ReactNode }) {
  return (
    <Link href={recordHref({ table, id })} className="text-link underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

export function Day({ value }: { value: string | null }) {
  return value ? <span className="tabular-nums whitespace-nowrap">{formatLocalDate(value)}</span> : <span>None</span>;
}

// A label and its value, for a record's header facts. A trucking or pay word names its help, so
// the label shows it on hover, focus or tap.
export function Facts({ items }: { items: { label: string; value: ReactNode; term?: TermId }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => (
        <div key={i.label} className="grid min-w-0 gap-0.5">
          <dt className="text-small text-foreground-2">{i.term ? <Term id={i.term}>{i.label}</Term> : i.label}</dt>
          <dd className="min-w-0 text-body text-foreground">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// How late an open balance is, by the day it was due.
export const BUCKET_WORDS: Readonly<Record<string, string>> = {
  current: "Not due yet",
  "1_30": "1 to 30 days late",
  "31_60": "31 to 60 days late",
  "61_90": "61 to 90 days late",
  over_90: "Over 90 days late",
};
