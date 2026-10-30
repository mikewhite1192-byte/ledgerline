"use client";

import { useId, useState, type ReactNode } from "react";
import { AnswerText } from "@/components/app/answer-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { countWords, isNotesLine, type TraceLine } from "@/lib/trace/format";
import { NO_NOTE, NOTE_NOT_KEPT, type StepThrough, type StepTurn, type SummaryShape } from "@/lib/trace/steps";
import type { recordNamer } from "@/lib/format/labels";
import { NOTE_REF_TABLE, noteHref } from "@/lib/memory/links";
import { hrefOrNull, type HrefFor } from "@/lib/records/href";

// One row of a trace (who did it, its time and cost, what happened, the records it read), shared
// by the list of steps and the step-through. step, when set, is the row's place in the list.
export function TraceRow({
  line,
  step,
  hrefFor,
  name,
}: {
  line: TraceLine;
  step?: number;
  hrefFor: HrefFor;
  name: ReturnType<typeof recordNamer>;
}) {
  return (
    <li className="grid gap-1 border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The list's own order tells a screen reader the number; Details names rows by it. */}
        {step !== undefined ? (
          <span aria-hidden className="text-small text-muted-foreground tabular-nums">
            {step}.
          </span>
        ) : null}
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

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The step-through: one model call per screen, "Turn 2 of 4", with Previous and Next. Four short
// blocks, side by side from a tablet up and stacked on a phone. fullSummary shows the summary's
// own text under "Show the summary", for the carrier's own people; without it only the sections
// and their lengths show.
export function StepView({
  through,
  hrefFor,
  name,
  fullSummary,
}: {
  through: StepThrough;
  hrefFor: HrefFor;
  name: ReturnType<typeof recordNamer>;
  fullSummary: boolean;
}) {
  const [at, setAt] = useState(0);
  const total = through.turns.length;
  if (total === 0) return null;
  const index = Math.min(at, total - 1);
  const turn = through.turns[index];
  const details = [turn.model, ...turn.got].filter((l) => l.effort || l.cache);
  return (
    <section className="grid gap-3" aria-label="Step through">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-small font-semibold text-foreground" aria-live="polite">
          {`Turn ${index + 1} of ${total}`}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => setAt(index - 1)}>
            Previous
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={index === total - 1} onClick={() => setAt(index + 1)}>
            Next
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-small font-semibold text-foreground">{turn.model.who}</span>
        {turn.model.meta.length > 0 ? (
          <span className="text-small text-muted-foreground tabular-nums">{turn.model.meta.join(", ")}</span>
        ) : null}
        {turn.model.badge ? <Badge tone={turn.model.badge.tone}>{turn.model.badge.label}</Badge> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Block title="What it saw">
          <Saw turn={turn} first={index === 0} summary={through.summary} summaryText={fullSummary ? through.summaryText : null} />
        </Block>
        <Block title="Its note">
          {turn.note !== null ? <AnswerText text={turn.note} className="text-foreground-2" /> : <p className="text-body text-foreground-2">{through.summary === null ? NOTE_NOT_KEPT : NO_NOTE}</p>}
        </Block>
        <Block title="What it did">
          <p className="text-body text-foreground-2">{turn.model.text}</p>
          {turn.asked.length > 0 ? (
            <ol className="grid list-decimal gap-0.5 pl-5 text-body text-foreground-2" aria-label="Tools it asked for">
              {turn.asked.map((label, i) => (
                <li key={i}>{label}</li>
              ))}
            </ol>
          ) : null}
        </Block>
        <Block title="What came back">
          {turn.got.length > 0 ? (
            <ul className="grid gap-3" aria-label="What came back">
              {turn.got.map((line) => (
                <TraceRow key={line.key} line={line} hrefFor={hrefFor} name={name} />
              ))}
            </ul>
          ) : (
            <p className="text-body text-foreground-2">
              {turn.answered ? "Nothing more: this step wrote the answer." : "Nothing came back for this step."}
            </p>
          )}
        </Block>
      </div>
      {details.length > 0 ? (
        <details className="text-small">
          <summary className="w-fit cursor-pointer rounded-sm text-link underline-offset-4 hover:underline">Details</summary>
          <ul className="mt-2 grid gap-2" aria-label="Details for this turn">
            {details.map((line) => (
              <li key={line.key} className="grid gap-0.5">
                <span className="font-semibold text-foreground">{line.who}</span>
                {line.effort ? <span className="text-muted-foreground">Asked for {line.effort}</span> : null}
                {line.cache ? <span className="text-muted-foreground tabular-nums">{capitalize(line.cache)}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5 rounded-md border border-border px-3 py-2">
      <h4 className="text-small font-semibold text-foreground">{title}</h4>
      {children}
    </div>
  );
}

// What the call was given: the summary of the carrier's records the answer started from (its
// sections and their lengths, and its own text when allowed), what was read before the first
// call, and what the earlier tools sent back.
function Saw({
  turn,
  first,
  summary,
  summaryText,
}: {
  turn: StepTurn;
  first: boolean;
  summary: SummaryShape | null;
  summaryText: string | null;
}) {
  const textId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-2">
      {summary ? (
        <div className="grid gap-1">
          <p className="text-body text-foreground-2">
            The summary of your records this answer started from, {countWords(summary.chars, "character", "characters")}:
          </p>
          {summary.parts.length > 0 ? (
            <ul className="grid gap-0.5 text-small text-foreground-2" aria-label="Parts of the summary">
              {summary.parts.map((p, i) => (
                <li key={i}>
                  {p.title}, {countWords(p.lines, "line", "lines")}
                </li>
              ))}
            </ul>
          ) : null}
          {summaryText !== null ? (
            <>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="justify-self-start"
                aria-expanded={open}
                aria-controls={textId}
                onClick={() => setOpen(!open)}
              >
                {open ? "Hide the summary" : "Show the summary"}
              </Button>
              {/* Shown only once opened: the model's own input, word for word, as plain text. */}
              <div id={textId} hidden={!open}>
                {open ? (
                  <pre
                    data-verbatim="summary"
                    className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-caption text-foreground-2"
                  >
                    {summaryText}
                  </pre>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-body text-foreground-2">The summary this answer started from was not kept for it.</p>
      )}
      {first && turn.before.length > 0 ? (
        <ul className="grid gap-0.5 text-small text-foreground-2" aria-label="Read before this step">
          {turn.before.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      ) : null}
      {turn.earlier.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-body text-foreground-2">What the earlier steps sent back:</p>
          <ul className="grid gap-0.5 text-small text-foreground-2" aria-label="What the earlier steps sent back">
            {turn.earlier.map((line) => (
              <li key={line.key}>
                {line.text}
                {line.refs.length > 0 ? ` (${countWords(line.refs.length, "record", "records")})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
