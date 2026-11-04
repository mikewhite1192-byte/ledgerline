"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { FeedLine } from "@/lib/feed/words";
import { STEP_TITLES, STEP_KEYS, type BoardRow, type StepState } from "@/lib/journey/steps";

const LINK = "text-small text-link underline-offset-4 hover:underline";

const STRIP_DOT: Readonly<Record<StepState, string>> = {
  done: "border-success bg-success",
  now: "border-info bg-card animate-step-now",
  waiting: "border-border bg-card",
  stopped: "border-warning bg-warning-soft",
  skipped: "border-dashed border-border bg-muted",
};

// What the person reads beside the strip: the step the load stands at and how it stands.
function stepLine(row: BoardRow): string {
  if (row.stepState === "finished") return row.stepTitle;
  if (row.stepState === "stopped") return `Stopped at: ${row.stepTitle}`;
  return `Next: ${row.stepTitle}`;
}

// Each row's step states at the last render, kept across the page's own refreshes, so a dot that
// just turned done fills once and a refresh where nothing moved replays nothing.
function useSeenRows(rows: readonly BoardRow[]): ReadonlyMap<string, readonly StepState[]> | null {
  const seen = useRef<ReadonlyMap<string, readonly StepState[]> | null>(null);
  const before = seen.current;
  useEffect(() => {
    seen.current = new Map(rows.map((r) => [r.loadId, r.steps]));
  }, [rows]);
  return before;
}

// The keys shown at the last render, so a line new since then slides in once at the top. None on
// the first render.
function useSeenKeys(lines: readonly FeedLine[]): ReadonlySet<string> | null {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const before = seen.current;
  useEffect(() => {
    seen.current = new Set(lines.map((l) => l.key));
  }, [lines]);
  return before;
}

// One load's eight steps as a strip of dots, done ones filled.
function StepStrip({ row, before }: { row: BoardRow; before: readonly StepState[] | undefined }) {
  const done = row.steps.filter((s) => s === "done").length;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">{`${done} of ${row.steps.length} steps done.`}</span>
      {row.steps.map((state, i) => {
        const fresh = before !== undefined && state === "done" && before[i] !== "done";
        return (
          <span
            key={STEP_KEYS[i] ?? i}
            aria-hidden
            title={STEP_KEYS[i] ? STEP_TITLES[STEP_KEYS[i]] : undefined}
            {...(fresh ? { "data-motion": "" } : {})}
            className={cn("size-2.5 shrink-0 rounded-full border-2", STRIP_DOT[state], fresh && "animate-step-fill")}
          />
        );
      })}
    </span>
  );
}

// The On the road board: one row per load still on its way to being paid and recorded, soonest
// delivery first. Where a load is comes from what happened, never a map position.
export function RoadBoard({ rows }: { rows: readonly BoardRow[] }) {
  const before = useSeenRows(rows);
  return (
    <ul aria-label="Loads on the road" className="grid divide-y divide-border">
      {rows.map((row) => (
        <li key={row.loadId} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:gap-4">
          <div className="min-w-0">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <Link href={row.href} className="text-body font-semibold text-foreground underline-offset-4 hover:underline">
                Load {row.number}
              </Link>
              <span className="min-w-0 break-words text-small text-foreground-2">
                {row.driver ?? "No driver yet"}
                {row.truck ? `, truck ${row.truck}` : ""}
              </span>
            </p>
            <p className="mt-0.5 break-words text-small text-foreground">{row.route}</p>
            <p className="mt-0.5 break-words text-small text-foreground-2">{row.where}</p>
          </div>
          <div className="grid min-w-0 content-start gap-1">
            <p className="flex flex-wrap items-center gap-2">
              {row.late ? <Badge tone="warning">Late</Badge> : null}
              <span className={cn("text-small", row.late ? "text-warning" : "text-foreground")}>
                {row.due ?? "No delivery time on file"}
              </span>
            </p>
            <p className="flex min-w-0 flex-wrap items-center gap-2">
              <StepStrip row={row} before={before?.get(row.loadId)} />
              <span className="min-w-0 text-small text-foreground-2">{stepLine(row)}</span>
            </p>
            <p>
              <Link href={row.href} className={LINK}>
                Watch the journey
              </Link>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// The newest journey steps across the board, newest first, in the live feed's look. A line new
// since the last refresh slides into the top once.
export function RoadStream({ lines }: { lines: readonly FeedLine[] }) {
  const before = useSeenKeys(lines);
  return (
    <ul aria-label="Latest journey steps" className="grid divide-y divide-border">
      {lines.map((line) => {
        const fresh = before !== null && !before.has(line.key);
        return (
          <li
            key={line.key}
            {...(fresh ? { "data-motion": "" } : {})}
            className={cn("grid gap-1 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4", fresh && "animate-slide-in")}
          >
            <time dateTime={line.at} className="text-small text-foreground-2">
              {line.time}
            </time>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              {fresh ? <Badge tone="info">New</Badge> : null}
              <span className="min-w-0 text-body text-foreground">{line.words}</span>
              {line.actor ? <span className="text-small text-foreground-2">{line.actor}</span> : null}
              {line.tag ? <Badge>{line.tag}</Badge> : null}
              {line.href ? (
                <Link href={line.href} className={LINK}>
                  Watch the journey
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
