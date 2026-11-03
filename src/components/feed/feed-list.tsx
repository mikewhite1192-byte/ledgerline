"use client";

import Link from "next/link";
import { useRef } from "react";
import { Badge } from "@/components/ui/badge";
import type { FeedLine } from "@/lib/feed/words";

const LINK = "text-small text-link underline-offset-4 hover:underline";

// The feed's lines, newest first: the time over the words on a phone, beside them on a wider
// screen, a tag where the money went or how the autopilot ruled, and the record's page when it has
// one. With markNew, a line newer than the newest one shown when the page opened reads "New".
export function FeedList({ lines, markNew = false }: { lines: readonly FeedLine[]; markNew?: boolean }) {
  // The newest line at first render, kept across the page's own refreshes. Lines sort by (at, key),
  // keys byte by byte as the query's COLLATE "C" does, so a later line at the same instant is new too.
  const first = lines[0];
  const seen = useRef<{ at: string; key: string } | null>(first ? { at: first.at, key: first.key } : null);
  const since = seen.current;
  return (
    <ul aria-label="Live feed lines" className="grid divide-y divide-border">
      {lines.map((line) => {
        const fresh =
          markNew && since !== null && (line.at > since.at || (line.at === since.at && line.key > since.key));
        return (
          <li key={line.key} className="grid gap-1 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
            <time dateTime={line.at} className="text-small text-foreground-2">
              {line.time}
            </time>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              {fresh ? <Badge tone="info">New</Badge> : null}
              <span className="min-w-0 text-body text-foreground">{line.words}</span>
              {line.tag ? <Badge>{line.tag}</Badge> : null}
              {line.href ? (
                <Link href={line.href} className={LINK}>
                  Open the record
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
