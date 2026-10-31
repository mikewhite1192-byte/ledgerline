"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAFF_ONLY_NOTE } from "@/components/app/staff-only";
import type { AskAction, AskState, AsksControl } from "./ask-card";
import {
  asksOf,
  isIso,
  mergeAsks,
  nextPoll,
  POLL_START,
  pollDelay,
  pollStops,
  readDismissed,
  writeDismissed,
  type LiveAsk,
  type PollEvent,
} from "./asks";
import { STEP_FAILED, YES_UNKNOWN, yesConfirmation, yesRefused } from "./words";

// The launcher's side of the agent's questions: the poll of GET /api/agent/asks on the schedule in
// ./asks.ts, the three answers (Yes through the usual approve route, Not now, Got it), and the
// questions this person closed with the x. Never opens the card by itself; never sends any words
// of its own to the server.

// The desk writes a question with its wake's clock and commits a little later, so each look asks
// from a few minutes before the server's last clock; ids already held are not new.
const OVERLAP_MS = 5 * 60_000;
// How long the line after Yes stays in the bubble before the next question shows.
const SETTLED_MS = 5_000;

const localStore = () => localStorage;

async function errorOf(res: Response): Promise<unknown> {
  try {
    return ((await res.json()) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

export function useLiveAsks({
  on,
  storeKey,
  onQuestion,
}: {
  // flags.agentAsks.enabled as the page's server read it; off, nothing is asked for.
  on: boolean;
  // asks: and an opaque value, for the closed set; without it the x closes the question on this page only.
  storeKey?: string;
  onQuestion: (ask: LiveAsk) => void;
}) {
  const [live, setLive] = useState<LiveAsk[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [states, setStates] = useState<Record<string, AskState>>({});
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  // Read once as the page loads; nothing shows before the first reply, so the server's render and
  // the browser's first render are the same.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
    typeof window === "undefined" ? new Set() : readDismissed(storeKey, localStore),
  );
  const poll = useRef(POLL_START);
  const since = useRef<string | null>(null);
  const known = useRef(new Set<string>());
  const rearm = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const question = useRef(onQuestion);
  useEffect(() => {
    question.current = onQuestion;
  });

  useEffect(() => {
    alive.current = true;
    const live = timers.current;
    return () => {
      alive.current = false;
      for (const t of live) clearTimeout(t);
      live.clear();
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      if (alive.current) fn();
    }, ms);
    timers.current.add(t);
  }, []);

  useEffect(() => {
    if (!on) return;
    let ended = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = () => document.visibilityState === "visible";
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clear();
      if (ended) return;
      const delay = pollDelay(poll.current, visible());
      if (delay !== null) timer = setTimeout(() => void look(), delay);
    };
    async function look() {
      timer = null;
      if (busy || ended || poll.current.stopped) return;
      busy = true;
      let event: PollEvent;
      try {
        const from = since.current;
        const res = await fetch(from ? `/api/agent/asks?since=${encodeURIComponent(from)}` : "/api/agent/asks", {
          cache: "no-store",
        });
        if (pollStops(res.status)) event = { kind: "stop" };
        else if (res.status !== 200) event = { kind: "failed" };
        else {
          const body = (await res.json()) as { asks?: unknown; openCount?: unknown; now?: unknown };
          const asks = asksOf(body.asks);
          const count =
            typeof body.openCount === "number" && Number.isSafeInteger(body.openCount) && body.openCount >= 0
              ? body.openCount
              : null;
          if (isIso(body.now)) since.current = new Date(Date.parse(body.now) - OVERLAP_MS).toISOString();
          const fresh = asks.filter((a) => !known.current.has(a.id));
          for (const a of asks) known.current.add(a.id);
          if (!ended) {
            // Nothing showing at all: whatever this page still held was decided somewhere else.
            setLive((held) => (count === 0 ? [] : mergeAsks(held, asks)));
            if (count !== null) setOpenCount(count);
          }
          event = { kind: "reply", fresh: fresh.length };
        }
      } catch {
        event = { kind: "failed" };
      }
      busy = false;
      poll.current = nextPoll(poll.current, event);
      schedule();
    }
    // Hidden, the poll waits; shown again, it looks at once.
    const onVisibility = () => {
      if (!visible()) clear();
      else if (timer === null && !busy && !poll.current.stopped) void look();
    };
    document.addEventListener("visibilitychange", onVisibility);
    rearm.current = schedule;
    if (visible()) void look();
    return () => {
      ended = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
      rearm.current = null;
    };
  }, [on]);

  const setState = useCallback((id: string, state: AskState) => {
    if (alive.current) setStates((s) => ({ ...s, [id]: state }));
  }, []);

  // Answered here: out of the bubble and the count, and the poll back to its quick pace.
  const answered = useCallback(
    (id: string, settled?: string) => {
      if (!alive.current) return;
      setOpenCount((n) => Math.max(0, n - 1));
      poll.current = nextPoll(poll.current, { kind: "answered" });
      rearm.current?.();
      const hide = () => setGone((g) => new Set(g).add(id));
      if (settled) {
        setState(id, { settled });
        later(hide, SETTLED_MS);
      } else {
        hide();
      }
    },
    [later, setState],
  );

  const act = useCallback(
    async (ask: LiveAsk, action: AskAction) => {
      setState(ask.id, { busy: action });
      if (action === "yes") {
        // The proposal card's own request for a pass: anything that needs the second confirm or
        // a reason is refused by the gate (needs_confirm), and the line says to open the card.
        try {
          const res = await fetch(`/api/proposals/${encodeURIComponent(ask.proposalId)}/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirmed: false }),
          });
          if (res.ok) {
            const body = (await res.json().catch(() => ({}))) as { status?: unknown };
            answered(ask.id, yesConfirmation(ask.proposalKind, body.status));
          } else if (res.status >= 500) {
            // A server error may have come after the approval went through.
            setState(ask.id, { note: YES_UNKNOWN });
          } else {
            setState(ask.id, { note: yesRefused(await errorOf(res), STAFF_ONLY_NOTE) });
          }
        } catch {
          setState(ask.id, { note: YES_UNKNOWN });
        }
        return;
      }
      const path = action === "not_now" ? "snooze" : "ack";
      try {
        const res = await fetch(`/api/asks/${encodeURIComponent(ask.id)}/${path}`, { method: "POST" });
        // 404: no longer live (decided, put off or seen somewhere else), so it simply goes.
        if (res.ok || res.status === 404) {
          setState(ask.id, {});
          answered(ask.id);
        } else {
          const category = await errorOf(res);
          setState(ask.id, { note: category === "judge" ? STAFF_ONLY_NOTE : STEP_FAILED });
        }
      } catch {
        setState(ask.id, { note: STEP_FAILED });
      }
    },
    [answered, setState],
  );

  const dismiss = useCallback(
    (id: string) => {
      setDismissed((d) => {
        const next = new Set(d).add(id);
        writeDismissed(storeKey, next, localStore);
        return next;
      });
    },
    [storeKey],
  );

  const control = useMemo<AsksControl>(
    () => ({
      live,
      states,
      gone,
      act: (ask, action) => void act(ask, action),
      question: (ask) => question.current(ask),
    }),
    [live, states, gone, act],
  );

  // The bubble's question: the newest showing that was not answered or closed here.
  const showing = live.filter((a) => !gone.has(a.id) && !dismissed.has(a.id));
  const current = showing[0] ?? null;
  return { control, openCount, current, more: Math.max(0, showing.length - 1), dismiss };
}
