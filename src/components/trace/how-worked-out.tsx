"use client";

import { ChevronRight, ListTree } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/app/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { traceLines, traceTotals, type TraceLine } from "@/lib/trace/format";
import type { TurnTrace } from "@/lib/trace/types";
import { cn } from "@/lib/cn";
import { recordNamer } from "@/lib/format/labels";
import { hrefOrNull, recordHref, type HrefFor } from "@/lib/records/href";

// "How this was worked out": under an answer (the whole turn) or a proposal card (that card's
// steps and checks). Closed by default and read only when first opened, so a thread of answers
// costs no reads until someone looks. The anchor id (trace-<proposal or turn id>) opens it from a
// link, such as an auditor footnote pointing at #trace-<proposal id>.

export type TraceLoad = { trace: TurnTrace } | { missing: true } | { error: string };
export type TraceLoader = (turnId: string) => Promise<TraceLoad>;

// The default loader: the trace route. A 404 is a turn this person cannot see; anything else that
// is not a trace is an error, never an empty trace.
export async function fetchTrace(turnId: string): Promise<TraceLoad> {
  return fetchTraceAt(`/api/agent/turns/${encodeURIComponent(turnId)}/trace`);
}

// A trace from any route that answers { trace } (a sweep run's route reads the run's own turns),
// with the same answers as the default loader.
export async function fetchTraceAt(path: string): Promise<TraceLoad> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store" });
  } catch {
    return { error: "unreadable" };
  }
  if (res.status === 404) return { missing: true };
  if (res.status === 403) return { error: "forbidden" };
  if (!res.ok) return { error: "unreadable" };
  try {
    const body = (await res.json()) as { trace?: TurnTrace };
    return body.trace ? { trace: body.trace } : { error: "unreadable" };
  } catch {
    return { error: "unreadable" };
  }
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; trace: TurnTrace }
  | { kind: "missing" }
  | { kind: "error"; category: string };

export function traceAnchor(turnId: string, proposalId?: string): string {
  return `trace-${proposalId ?? turnId}`;
}

function Line({ line, hrefFor, name }: { line: TraceLine; hrefFor: HrefFor; name: ReturnType<typeof recordNamer> }) {
  return (
    <li className="grid gap-1 border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-small font-semibold text-foreground">{line.who}</span>
        {line.meta.length > 0 ? (
          <span className="text-small text-muted-foreground tabular-nums">{line.meta.join(", ")}</span>
        ) : null}
        {line.badge ? <Badge tone={line.badge.tone}>{line.badge.label}</Badge> : null}
      </div>
      <p className="text-body text-foreground-2">{line.text}</p>
      {line.cache ? <p className="text-small text-muted-foreground tabular-nums">{line.cache}</p> : null}
      {line.refs.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Records it read">
          {line.refs.map((ref) => {
            const href = hrefOrNull(hrefFor, ref);
            const label = name(ref);
            return (
              <li key={`${ref.table}:${ref.id}`} className="text-small">
                {href ? (
                  <a href={href} className="text-primary underline-offset-2 hover:underline">
                    {label}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export function HowWorkedOut({
  turnId,
  proposalId,
  load = fetchTrace,
  hrefFor = recordHref,
  className,
}: {
  turnId: string;
  proposalId?: string;
  load?: TraceLoader;
  hrefFor?: HrefFor;
  className?: string;
}) {
  const anchor = traceAnchor(turnId, proposalId);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const alive = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const mine = ++request.current;
    setState({ kind: "loading" });
    let got: TraceLoad;
    try {
      got = await load(turnId);
    } catch {
      got = { error: "unreadable" };
    }
    // A closed component or a newer read wins; this answer is dropped.
    if (!alive.current || mine !== request.current) return;
    if ("trace" in got) setState({ kind: "ready", trace: got.trace });
    else if ("missing" in got) setState({ kind: "missing" });
    else setState({ kind: "error", category: got.error });
  }, [load, turnId]);

  useEffect(() => {
    if (open && state.kind === "idle") void read();
  }, [open, state.kind, read]);

  // A link to #trace-<id> opens this one, on load and on a later hash change.
  useEffect(() => {
    const check = () => {
      if (window.location.hash === `#${anchor}`) setOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [anchor]);

  const toggle = () => {
    if (!open && state.kind === "error") setState({ kind: "idle" });
    setOpen(!open);
  };

  return (
    <div id={anchor} className={cn("grid scroll-mt-24 gap-2", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start px-2 text-foreground-2"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <ChevronRight aria-hidden className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        How this was worked out{" "}
        {/* A thread holds one under each answer and each card; the hidden words tell them apart. */}
        <VisuallyHidden>{proposalId ? "for this card" : "for this answer"}</VisuallyHidden>
      </Button>
      <div id={panelId} hidden={!open} className="rounded-lg border border-border bg-card px-4 py-3">
        {open ? <Body state={state} proposalId={proposalId} hrefFor={hrefFor} onRetry={() => void read()} /> : null}
      </div>
    </div>
  );
}

function Body({
  state,
  proposalId,
  hrefFor,
  onRetry,
}: {
  state: State;
  proposalId?: string;
  hrefFor: HrefFor;
  onRetry: () => void;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return <LoadingState label="Reading how this was worked out" rows={3} />;
  }
  if (state.kind === "missing") {
    return <ErrorState category="not_found" className="py-4" />;
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        category={state.category}
        className="py-4"
        retry={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  const lines = traceLines(state.trace, proposalId);
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<ListTree aria-hidden />}
        title="Nothing on file for this yet"
        body="No model calls or safety checks were recorded for it."
        className="py-4"
      />
    );
  }
  const totals = traceTotals(state.trace, proposalId);
  // One name per record across every step, so a record read twice reads the same both times.
  const name = recordNamer(lines.flatMap((l) => l.refs));
  return (
    <div className="grid gap-3">
      <ol className="grid gap-3" aria-label="Steps, in order">
        {lines.map((line) => (
          <Line key={line.key} line={line} hrefFor={hrefFor} name={name} />
        ))}
      </ol>
      {totals ? <p className="border-t border-border pt-2 text-small text-muted-foreground tabular-nums">{totals}</p> : null}
    </div>
  );
}
