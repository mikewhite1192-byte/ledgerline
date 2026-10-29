"use client";

import { ChevronRight, ListTree } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/app/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { isNotesLine, traceLines, traceModels, traceTotals, type TraceLine, type TraceModel } from "@/lib/trace/format";
import type { TurnTrace } from "@/lib/trace/types";
import { cn } from "@/lib/cn";
import { recordNamer } from "@/lib/format/labels";
import { NOTE_REF_TABLE, noteHref } from "@/lib/memory/links";
import { hrefOrNull, recordHref, type HrefFor } from "@/lib/records/href";

// "How this was worked out": under an answer (the whole turn) or a proposal card (that card's
// steps and checks). Closed by default and read only when first opened, so a thread of answers
// costs no reads until someone looks. The anchor id (trace-<proposal or turn id>) opens it from a
// link, such as an auditor footnote pointing at #trace-<proposal id>. Opened, it reads in three
// groups: the steps in order (who did each, its time and cost, what happened), the models used
// (each model's job, calls, time and cost), and a closed Details with each call's effort and
// prompt cache figures, for the reader who wants them.

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

function Line({
  line,
  step,
  hrefFor,
  name,
}: {
  line: TraceLine;
  step: number;
  hrefFor: HrefFor;
  name: ReturnType<typeof recordNamer>;
}) {
  return (
    <li className="grid gap-1 border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The list's own order tells a screen reader the number; Details names rows by it. */}
        <span aria-hidden className="text-small text-muted-foreground tabular-nums">
          {step}.
        </span>
        <span className="text-small font-semibold text-foreground">{line.who}</span>
        {line.meta.length > 0 ? (
          <span className="text-small text-muted-foreground tabular-nums">{line.meta.join(", ")}</span>
        ) : null}
        {line.badge ? <Badge tone={line.badge.tone}>{line.badge.label}</Badge> : null}
      </div>
      <p className="text-body text-foreground-2">{line.text}</p>
      {line.refs.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label={isNotesLine(line) ? "Notes it read" : "Records it read"}>
          {line.refs.map((ref) => {
            // A carrier note links to its row on the Memory page, never to a record page.
            const href = ref.table === NOTE_REF_TABLE ? noteHref(ref.id) : hrefOrNull(hrefFor, ref);
            const label = ref.label ?? name(ref);
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
  const models = traceModels(state.trace, proposalId);
  const details = lines.flatMap((line, i) => (line.effort || line.cache ? [{ line, step: i + 1 }] : []));
  // One name per record across every step, so a record read twice reads the same both times.
  const name = recordNamer(lines.flatMap((l) => l.refs));
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <GroupTitle>Steps</GroupTitle>
        <ol className="grid gap-3" aria-label="Steps, in order">
          {lines.map((line, i) => (
            <Line key={line.key} line={line} step={i + 1} hrefFor={hrefFor} name={name} />
          ))}
        </ol>
      </div>
      {models.length > 0 ? <ModelsUsed models={models} /> : null}
      {totals ? <p className="border-t border-border pt-2 text-small text-muted-foreground tabular-nums">{totals}</p> : null}
      {details.length > 0 ? (
        <details className="text-small">
          <summary className="w-fit cursor-pointer rounded-sm text-link underline-offset-4 hover:underline">Details</summary>
          <ul className="mt-2 grid gap-2" aria-label="Details for each step">
            {details.map(({ line, step }) => (
              <li key={line.key} className="grid gap-0.5">
                <span className="font-semibold text-foreground">
                  Step {step}, {line.who}
                </span>
                {line.effort ? <span className="text-muted-foreground">Asked for {line.effort}</span> : null}
                {line.cache ? <span className="text-muted-foreground tabular-nums">{capitalize(line.cache)}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function GroupTitle({ children }: { children: string }) {
  return <h3 className="text-small font-semibold text-foreground">{children}</h3>;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Each model behind these steps, once: its job in a few words, then its calls, time and cost.
function ModelsUsed({ models }: { models: TraceModel[] }) {
  return (
    <div className="grid gap-2">
      <GroupTitle>Models used</GroupTitle>
      <ul className="grid gap-2" aria-label="Models used">
        {models.map((m) => (
          <li key={m.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-l-2 border-border pl-3">
            <span className="grid">
              <span className="text-small font-semibold text-foreground">{m.name}</span>
              <span className="text-small text-foreground-2">{m.job}</span>
            </span>
            <span className="text-small text-muted-foreground tabular-nums">
              {[m.calls, m.time, m.cost].filter(Boolean).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
