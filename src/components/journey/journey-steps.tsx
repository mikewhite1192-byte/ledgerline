"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { Money } from "@/components/app/money";
import { lineDescription } from "@/components/app/paystub";
import { claimRows, fieldLabel, fieldStatusBadge, kindLabel, matchedLabel, noneSentence } from "@/components/documents/labels";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import type { JourneyDocument, JourneyStep, PaystubSummary, StepKey, StepState } from "@/lib/journey/steps";
import { CountUp } from "./count-up";

const LINK = "text-small text-link underline-offset-4 hover:underline";

const STATE_BADGES: Readonly<Record<StepState, { label: string; tone: BadgeTone }>> = {
  done: { label: "Done", tone: "success" },
  now: { label: "Now", tone: "info" },
  waiting: { label: "Still to come", tone: "neutral" },
  stopped: { label: "Stopped", tone: "warning" },
  skipped: { label: "Not needed", tone: "neutral" },
};

const DOT: Readonly<Record<StepState, string>> = {
  done: "border-success bg-success",
  now: "border-info bg-card animate-step-now",
  waiting: "border-border bg-card",
  stopped: "border-warning bg-warning-soft",
  skipped: "border-dashed border-border bg-muted",
};

// The gap between one read field's reveal and the next.
const STAGGER_MS = 110;

// The steps that just turned done since the last render: none on the first render, so a page
// opened mid-journey, a page without script and every refresh where nothing moved show still.
function useFreshSteps(steps: readonly JourneyStep[]): ReadonlySet<StepKey> {
  const seen = useRef<ReadonlyMap<StepKey, StepState> | null>(null);
  const before = seen.current;
  const fresh = new Set<StepKey>();
  if (before !== null) {
    for (const s of steps) if (s.state === "done" && before.get(s.key) !== "done") fresh.add(s.key);
  }
  useEffect(() => {
    seen.current = new Map(steps.map((s) => [s.key, s.state]));
  }, [steps]);
  return fresh;
}

// One read value's motion: a short rise, each a little after the one before. Only on a fresh step.
type Motion = { className?: string; style?: CSSProperties; "data-motion"?: "" };

function reveal(fresh: boolean, i: number): Motion {
  return fresh
    ? { className: "animate-reveal", style: { animationDelay: `${i * STAGGER_MS}ms` }, "data-motion": "" }
    : {};
}

function DocumentThumb({ doc, documentsOn }: { doc: JourneyDocument; documentsOn: boolean }) {
  const label = `${kindLabel(doc.kind)}: ${doc.filename}`;
  const image = doc.mime.startsWith("image/");
  const inner =
    image && documentsOn ? (
      // A stored photo from the app's own file route; next/image would proxy it for nothing.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/documents/${doc.id}/file`}
        alt={label}
        loading="lazy"
        className="size-16 shrink-0 rounded-md border border-border bg-muted object-cover"
      />
    ) : (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-small text-foreground">
        <FileText aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{doc.filename}</span>
      </span>
    );
  return documentsOn ? (
    <Link href={`/documents/${doc.id}`} className="inline-flex max-w-full" aria-label={image ? undefined : `Open ${label}`}>
      {inner}
    </Link>
  ) : (
    inner
  );
}

// What Muse Spark read off the paper, field by field with its confidence, then what code made of
// it. Every value is shown as a value, never as an instruction.
function DocumentRead({
  doc,
  loadId,
  loadNumber,
  fresh,
  documentsOn,
}: {
  doc: JourneyDocument;
  loadId: string;
  loadNumber: string;
  fresh: boolean;
  documentsOn: boolean;
}) {
  const rows = doc.read !== null ? claimRows(doc.read) : [];
  const match = doc.match;
  const checks = new Map(match !== null && match.found ? match.fields.map((f) => [f.name, f.status]) : []);
  let matchLine: string;
  if (match === null) matchLine = doc.read === null ? "Not read yet, so nothing was matched." : "Not matched yet.";
  else if (match.found && match.loadId === loadId) matchLine = `Matched to load ${loadNumber}`;
  else if (match.found) matchLine = `Matched to ${matchedLabel(doc) ?? "another record"}`;
  else matchLine = noneSentence(match.reason, doc.kind);
  const matchedHere = match !== null && match.found && match.loadId === loadId;
  return (
    <div className="mt-2 grid gap-2 rounded-md border border-border bg-background px-3 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <DocumentThumb doc={doc} documentsOn={documentsOn} />
        <div className="min-w-0">
          <p className="text-caption text-foreground-2">Read by Muse Spark</p>
          <p className="text-small text-foreground">{kindLabel(doc.kind)}</p>
        </div>
      </div>
      {rows.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {rows.map((r, i) => {
            const check = checks.get(r.name);
            const motion = reveal(fresh, i);
            return (
              <div
                key={r.key}
                {...motion}
                className={cn("flex min-w-0 flex-wrap items-baseline gap-x-2", motion.className)}
              >
                <dt className="text-small text-foreground-2">{fieldLabel(r.name)}</dt>
                <dd className="min-w-0 break-words text-small text-foreground">{r.value}</dd>
                {r.low ? <Badge tone="warning">Low confidence</Badge> : null}
                {check !== undefined && check !== "low_confidence" ? (
                  <Badge tone={fieldStatusBadge(check).tone}>{fieldStatusBadge(check).label}</Badge>
                ) : null}
              </div>
            );
          })}
        </dl>
      ) : null}
      {(() => {
        const motion = reveal(fresh, rows.length + 1);
        return (
          <p
            {...motion}
            className={cn("flex flex-wrap items-center gap-2 text-small", matchedHere ? "text-success" : "text-foreground-2", motion.className)}
          >
            {matchedHere ? <Badge tone="success">Code</Badge> : null}
            <span>{matchLine}</span>
          </p>
        );
      })()}
    </div>
  );
}

// The paystub that carries this load, as stored: its lines in order, this load's line marked, and
// the stored totals. Nothing is added up here.
function PaystubLines({ stub, fresh }: { stub: PaystubSummary; fresh: boolean }) {
  return (
    <section
      data-amounts="shown"
      aria-label={`Paystub for ${stub.period}`}
      className="mt-2 rounded-md border border-border bg-background px-3 py-3"
    >
      <ul className="grid gap-1.5">
        {stub.lines.map((l, i) => {
          const motion = reveal(fresh, i);
          return (
            <li
              key={l.seq}
              {...motion}
              className={cn("flex min-w-0 items-baseline justify-between gap-3", motion.className)}
            >
              <span className="min-w-0 text-small text-foreground">
                <span className="break-words">{lineDescription(l.label)}</span>
                {l.thisLoad ? (
                  <Badge tone="info" className="ml-2 align-middle">
                    This load
                  </Badge>
                ) : null}
                {l.note ? <span className="block text-caption text-foreground-2">{l.note}</span> : null}
              </span>
              <Money cents={l.amountCents} className="text-small" />
            </li>
          );
        })}
      </ul>
      <dl className="mt-2 grid gap-1 border-t border-border pt-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-small text-foreground-2">Gross pay</dt>
          <dd className="text-small">
            <Money cents={stub.grossCents} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-small text-foreground-2">Total deductions</dt>
          <dd className="text-small">
            <Money cents={-Math.abs(stub.deductionsCents)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-body font-semibold text-foreground">Net pay</dt>
          <dd className="text-body font-semibold">
            <Money cents={stub.netCents} tone="plain" />
          </dd>
        </div>
      </dl>
    </section>
  );
}

// The load's whole road as a vertical line of eight steps, always all eight. A step that just
// turned done fills its dot, grows the line down to the next step and glows once; its amount
// counts up and what the model read rises in field by field. The step the road waits on pulses;
// steps still to come are muted. Motion keys off a step changing between renders, so a refresh
// where nothing moved replays nothing, and none of it changes a figure: each is the stored one.
export function JourneySteps({
  steps,
  loadId,
  loadNumber,
  documentsOn,
}: {
  steps: readonly JourneyStep[];
  loadId: string;
  loadNumber: string;
  documentsOn: boolean;
}) {
  const fresh = useFreshSteps(steps);
  return (
    <ol aria-label={`Journey of load ${loadNumber}`} className="grid">
      {steps.map((s, i) => {
        const isFresh = fresh.has(s.key);
        const last = i === steps.length - 1;
        const badge = STATE_BADGES[s.state];
        const muted = s.state === "waiting" || s.state === "skipped";
        const lineOn = s.state === "done" || s.state === "skipped";
        return (
          <li
            key={s.key}
            aria-current={s.state === "now" ? "step" : undefined}
            data-state={s.state}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3"
          >
            <div className="relative flex justify-center" aria-hidden>
              <span
                {...(isFresh ? { "data-motion": "" } : {})}
                className={cn("relative z-10 mt-1.5 size-3.5 rounded-full border-2", DOT[s.state], isFresh && "animate-step-fill")}
              />
              {!last ? (
                <span className="absolute top-6 -bottom-1 left-1/2 w-0.5 -translate-x-1/2 overflow-hidden rounded-full bg-border">
                  {lineOn ? (
                    <span
                      {...(isFresh ? { "data-motion": "" } : {})}
                      className={cn(
                        "absolute inset-0 origin-top",
                        s.state === "done" ? "bg-success" : "bg-foreground-2/40",
                        isFresh && "animate-step-line",
                      )}
                    />
                  ) : null}
                </span>
              ) : null}
            </div>
            <div
              {...(isFresh ? { "data-motion": "" } : {})}
              className={cn("-mx-2 mb-2 min-w-0 rounded-md px-2 pt-0.5 pb-3", isFresh && "animate-step-glow")}
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className={cn("text-body font-semibold", muted ? "text-foreground-2" : "text-foreground")}>{s.title}</h3>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
              {s.time ? (
                <p className="mt-0.5 text-small text-foreground-2">
                  <time dateTime={s.at ?? undefined}>{s.time}</time>
                  {s.actor ? `, ${s.actor}` : ""}
                </p>
              ) : s.actor ? (
                <p className="mt-0.5 text-small text-foreground-2">{s.actor}</p>
              ) : null}
              <p className={cn("mt-1 text-body", muted ? "text-foreground-2" : "text-foreground")}>{s.fact}</p>
              {s.figureCents !== null || s.tag ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {s.figureCents !== null ? (
                    <span data-amounts="shown" className="text-lead font-semibold text-foreground">
                      {s.state === "done" ? (
                        <CountUp cents={s.figureCents} run={isFresh} />
                      ) : (
                        <Money cents={s.figureCents} tone="plain" />
                      )}
                    </span>
                  ) : null}
                  {s.tag ? <Badge>{s.tag}</Badge> : null}
                </div>
              ) : null}
              {s.document ? (
                <DocumentRead doc={s.document} loadId={loadId} loadNumber={loadNumber} fresh={isFresh} documentsOn={documentsOn} />
              ) : null}
              {s.paystub ? <PaystubLines stub={s.paystub} fresh={isFresh} /> : null}
              {s.href && s.hrefLabel ? (
                <p className="mt-2">
                  <Link href={s.href} className={LINK}>
                    {s.hrefLabel}
                  </Link>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
