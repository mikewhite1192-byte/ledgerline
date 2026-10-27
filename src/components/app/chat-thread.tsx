"use client";

import { Check, X } from "lucide-react";
import { Mark } from "@/components/brand/mark";
import { HowWorkedOut, type TraceLoader } from "@/components/trace/how-worked-out";
import { cn } from "@/lib/cn";
import { recordHref, type HrefFor } from "@/lib/records/href";
import { Composer, type ComposerProps } from "./composer";
import { DataTable, type DataTableProps } from "./data-table";
import { ProposalCard, type ProposalCardProps } from "./proposal-card";
import { PromptChips, type Suggestion } from "./prompt-chips";
import { ErrorState } from "./states";

export type Step = { id: string; label: string; state: "running" | "done" | "failed" };

export type Part =
  // warning: outside text the person should read with care; shown in a marked quote block.
  | { kind: "text"; text: string; warning?: string }
  | { kind: "steps"; steps: Step[] }
  | { kind: "proposal"; proposal: Omit<ProposalCardProps, "hrefFor"> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a thread mixes tables of any row shape
  | { kind: "table"; table: DataTableProps<any> }
  | { kind: "error"; category: string }
  // "How this was worked out" for the turn, or for one proposal card when proposalId is set.
  | { kind: "trace"; turnId: string; proposalId?: string; load?: TraceLoader };

export type ChatMessage = { id: string; role: "user" | "agent"; at?: string; parts: Part[] };

const STATE_WORD = { running: "working", done: "done", failed: "failed" } as const;

function StepDot({ state }: { state: Step["state"] }) {
  if (state === "done")
    return (
      <span className="grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check aria-hidden className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  if (state === "failed")
    return (
      <span className="grid size-4 place-items-center rounded-full bg-destructive text-destructive-foreground">
        <X aria-hidden className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  return <span className="block size-4 rounded-full border-2 border-primary motion-safe:animate-pulse-dot" />;
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ul className="grid gap-1.5" aria-label="What the agent did">
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2.5 text-body">
          <span className="mt-0.5 shrink-0">
            <StepDot state={s.state} />
          </span>
          <span
            className={cn(
              s.state === "done" && "text-foreground-2",
              s.state === "running" && "text-foreground",
              s.state === "failed" && "text-destructive",
            )}
          >
            {s.label}
            <span className="sr-only">, {STATE_WORD[s.state]}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function newestStep(messages: ChatMessage[]): Step | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.kind === "steps" && part.steps.length > 0) return part.steps[part.steps.length - 1];
    }
  }
  return null;
}

// The home: a question, a few suggested ones, and the box. Once there are messages, the thread:
// the person's questions on the right, the agent's steps, answers, proposals and tables on the
// left. Nothing here fetches; the caller streams messages in.
export function ChatThread({
  messages,
  suggestions = [],
  onPick,
  composer,
  hrefFor = recordHref,
  title = "What do you want to know?",
  intro,
  className,
}: {
  messages: ChatMessage[];
  suggestions?: Suggestion[];
  onPick?: (id: string) => void;
  composer: ComposerProps;
  hrefFor?: HrefFor;
  title?: string;
  intro?: string;
  className?: string;
}) {
  const latest = newestStep(messages);
  return (
    <div className={cn("mx-auto flex w-full max-w-[720px] flex-col gap-6", className)}>
      {messages.length === 0 ? (
        <div className="grid gap-4 pt-6 sm:pt-12">
          <div className="grid gap-1.5">
            <h2 className="text-h1 text-foreground">{title}</h2>
            {intro ? <p className="max-w-[60ch] text-lead text-foreground-2">{intro}</p> : null}
          </div>
          {suggestions.length > 0 ? <PromptChips prompts={suggestions} onPick={onPick} /> : null}
        </div>
      ) : (
        <ol className="grid gap-6" aria-label="Conversation">
          {messages.map((m) =>
            m.role === "user" ? (
              <li key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-secondary px-4 py-2.5 text-body text-foreground">
                  {m.parts.map((p, i) => (p.kind === "text" ? <p key={i}>{p.text}</p> : null))}
                  {/* On the bubble's fill, muted ink falls under 4.5:1, so the time takes the second ink. */}
                  {m.at ? <p className="mt-1 text-caption text-foreground-2">{m.at}</p> : null}
                </div>
              </li>
            ) : (
              <li key={m.id} className="flex gap-3">
                <Mark size={24} className="mt-0.5" />
                <div className="grid min-w-0 flex-1 gap-3">
                  <p className="sr-only">Agent</p>
                  {m.parts.map((p, i) => {
                    switch (p.kind) {
                      case "text":
                        return p.warning ? (
                          <figure key={i} className="grid max-w-[68ch] gap-1.5 rounded-lg border border-warning bg-warning-soft px-4 py-3">
                            <figcaption className="text-small font-semibold text-foreground">{p.warning}</figcaption>
                            <blockquote className="whitespace-pre-wrap break-words text-body text-foreground">{p.text}</blockquote>
                          </figure>
                        ) : (
                          <p key={i} className="max-w-[68ch] text-body text-foreground">
                            {p.text}
                          </p>
                        );
                      case "steps":
                        return <Steps key={i} steps={p.steps} />;
                      case "proposal":
                        // Keyed by the proposal, not its place, so an open confirm row stays with it.
                        return <ProposalCard key={`proposal:${p.proposal.id}`} {...p.proposal} hrefFor={hrefFor} />;
                      case "table":
                        return <DataTable key={i} {...p.table} />;
                      case "error":
                        return (
                          <div key={i} className="rounded-lg border border-border bg-card">
                            <ErrorState category={p.category} className="py-6" />
                          </div>
                        );
                      case "trace":
                        // Keyed by what it explains, so an open disclosure stays open across reads.
                        return (
                          <HowWorkedOut
                            key={`trace:${p.proposalId ?? p.turnId}`}
                            turnId={p.turnId}
                            proposalId={p.proposalId}
                            load={p.load}
                            hrefFor={hrefFor}
                          />
                        );
                    }
                  })}
                  {m.at ? <p className="text-caption text-muted-foreground">{m.at}</p> : null}
                </div>
              </li>
            ),
          )}
        </ol>
      )}
      <p className="sr-only" aria-live="polite" data-testid="step-announcer">
        {latest ? `${latest.label}, ${STATE_WORD[latest.state]}` : ""}
      </p>
      <Composer {...composer} />
    </div>
  );
}
