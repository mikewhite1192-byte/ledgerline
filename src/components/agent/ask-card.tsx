"use client";

import { X } from "lucide-react";
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { cn } from "@/lib/cn";
import type { LiveAsk } from "./asks";
import { ASK_WORDS } from "./words";

// One of the agent's questions (Yes, Not now, Ask a question) or told lines (Got it), drawn the
// same in the launcher's bubble and in the card's thread. The words come from the server, written
// by code; the buttons only call the launcher's control, which owns every request.

export type AskAction = "yes" | "not_now" | "got_it";

// busy: the action running now. note: why the last one did not go through, in fixed words.
// settled: the line after Yes went through.
export type AskState = { busy?: AskAction; note?: string; settled?: string };

export type AsksControl = {
  // Showing now, newest first, as the launcher last read them.
  live: readonly LiveAsk[];
  states: Readonly<Record<string, AskState>>;
  // Answered, put off, seen or found decided on this page: shown nowhere but as its settled line.
  gone: ReadonlySet<string>;
  act: (ask: LiveAsk, action: AskAction) => void;
  // Opens the card with "About load BR-1042: " in the box; the person writes and sends it.
  question: (ask: LiveAsk) => void;
};

export const AsksContext = createContext<AsksControl | null>(null);

export function useAsks(): AsksControl | null {
  return useContext(AsksContext);
}

export function AskCard({
  ask,
  state = {},
  control,
  more,
  onClose,
  className,
}: {
  ask: LiveAsk;
  state?: AskState;
  control: AsksControl;
  // "2 more waiting", in the bubble only.
  more?: string | null;
  // The bubble's x.
  onClose?: () => void;
  className?: string;
}) {
  const busy = state.busy !== undefined;
  return (
    <div
      data-ask={ask.id}
      className={cn("grid min-w-0 gap-2.5 rounded-xl border border-border bg-card p-3.5 text-foreground", className)}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-body">{ask.text}</p>
        {onClose ? (
          <button
            type="button"
            aria-label={ASK_WORDS.close}
            onClick={onClose}
            className="-mt-1 -mr-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-foreground-2 transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      {ask.reason ? <p className="text-small text-foreground-2">{ask.reason}</p> : null}
      {state.settled ? (
        <p role="status" className="text-small font-semibold text-foreground">
          {state.settled}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ask.kind !== "ask" ? (
            <Button size="sm" pending={state.busy === "got_it"} disabled={busy} onClick={() => control.act(ask, "got_it")}>
              {ASK_WORDS.gotIt}
            </Button>
          ) : (
            <>
              <Button size="sm" pending={state.busy === "yes"} disabled={busy} onClick={() => control.act(ask, "yes")}>
                {ASK_WORDS.yes}
              </Button>
              <Button
                size="sm"
                variant="outline"
                pending={state.busy === "not_now"}
                disabled={busy}
                onClick={() => control.act(ask, "not_now")}
              >
                {ASK_WORDS.notNow}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => control.question(ask)}>
                {ASK_WORDS.question}
              </Button>
            </>
          )}
        </div>
      )}
      {state.note ? (
        <InlineAlert tone="warning" className="px-3 py-2 text-small">
          {state.note}
        </InlineAlert>
      ) : null}
      {more ? <p className="text-caption text-muted-foreground">{more}</p> : null}
    </div>
  );
}
