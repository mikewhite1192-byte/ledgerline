"use client";

import { ChevronDown, Maximize2, Minimize2, Minus, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "@/components/app/prompt-chips";
import { LoadingState } from "@/components/app/states";
import { ViewerRoleProvider } from "@/components/app/viewer-role";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDetailsMenu } from "@/components/ui/details-menu";
import type { TurnView } from "@/lib/agent/view";
import { cn } from "@/lib/cn";
import type { Role } from "@/lib/roles";
import { AskCard, useAsks, type AsksControl } from "./ask-card";
import { asksOf, type LiveAsk } from "./asks";
import { FloatingDialog } from "./floating-dialog";
import type { PageFocus } from "./page-focus";
import type { Viewer } from "./proposal-card-from";
import { AgentChat, type Aside } from "./turn-view";
import { TRUST_LINE } from "./words";

// What the page's server read for the chat, the same settings Home passes its own chat.
export type AgentPanelConfig = {
  streamMode: "sse" | "poll";
  auditorOn: boolean;
  stepThrough: boolean;
  timezone: string;
  viewer: Viewer;
  role: Role;
  disabledReason?: string;
  // "Hey, <carrier>. How can I be helpful?", worked out on the server (words.ts).
  greeting: string;
  // The documents page, for the "+" menu, while documents are on.
  documentsHref?: string;
  // flags.agentAsks.enabled: the launcher asks for the agent's questions and shows them.
  asksOn?: boolean;
  // asks:<tenant>:<sub>, where this browser keeps the questions this person closed.
  asksKey?: string;
};

// One ask to open the card, numbered so each new one is seen once: text for the box and its help
// line, start a fresh conversation (?new=1), or scroll to a card in the thread (#card-<id>).
export type PanelRequest = { n: number; draft?: string; help?: string; fresh?: boolean; scrollTo?: string };

export const PANEL_ID = "agent-panel";

// The conversation the panel shows, kept for this browser tab. "New conversation" stores
// "left:<id>" for the one that was showing: the next page starts empty only while the newest
// conversation is still that one, so a newer one (asked on Home, say) shows as usual. A new id
// replaces the marker. Storage can be blocked or full; then each page simply reads the newest
// conversation.
const STORE_KEY = "pc-conversation";
const LEFT = "left:";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

// The conversation the person left with "New conversation", or null.
function leftConversation(): string | null {
  const stored = readStored();
  if (stored === null || !stored.startsWith(LEFT) || stored.length === LEFT.length) return null;
  return stored.slice(LEFT.length);
}

function clearStored() {
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing to do: the thread still works on this page.
  }
}

function writeStored(value: string) {
  try {
    sessionStorage.setItem(STORE_KEY, value);
  } catch {
    // Nothing to do: the thread still works on this page.
  }
}

function isTurnList(value: unknown): value is TurnView[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        typeof t === "object" && t !== null && typeof (t as { conversationId?: unknown }).conversationId === "string",
    )
  );
}

type ThreadItem = { type: "turn" | "ask"; id: string };

function threadOf(value: unknown): ThreadItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (x): x is ThreadItem =>
      typeof x === "object" &&
      x !== null &&
      ((x as ThreadItem).type === "turn" || (x as ThreadItem).type === "ask") &&
      typeof (x as ThreadItem).id === "string",
  );
}

type Recent = { turns: TurnView[]; asks: LiveAsk[]; order: ThreadItem[] };

const NO_RECENT: Recent = { turns: [], asks: [], order: [] };

// The caller's newest conversation, with the agent's questions showing now and the order of both
// by time. Anything but a clean 200 (the switch off, signed out, a slow or failed read) starts an
// empty thread: the panel never opens on an error.
async function readRecent(): Promise<Recent> {
  try {
    const res = await fetch("/api/agent/recent", { cache: "no-store" });
    if (res.status !== 200) return NO_RECENT;
    const body = (await res.json()) as { turns?: unknown; asks?: unknown; thread?: unknown };
    if (!isTurnList(body.turns)) return NO_RECENT;
    return { turns: body.turns, asks: asksOf(body.asks), order: threadOf(body.thread) };
  } catch {
    return NO_RECENT;
  }
}

// The thread's questions, each after the turn it followed in time; then any the launcher read
// after the thread loaded, after its last turn. One answered, put off or seen here shows no more,
// except as the line after its Yes.
function asidesOf(thread: Thread, control: AsksControl | null): Aside[] {
  if (!control) return [];
  const out: Aside[] = [];
  const placed = new Set<string>();
  const byId = new Map(thread.asks.map((a) => [a.id, a]));
  const place = (ask: LiveAsk, after: string | null) => {
    if (placed.has(ask.id)) return;
    placed.add(ask.id);
    const state = control.states[ask.id];
    if (control.gone.has(ask.id) && state?.settled === undefined) return;
    out.push({ id: ask.id, after, node: <AskCard ask={ask} state={state} control={control} /> });
  };
  let after: string | null = null;
  for (const item of thread.order) {
    if (item.type === "turn") after = item.id;
    else {
      const ask = byId.get(item.id.toLowerCase());
      if (ask) place(ask, after);
    }
  }
  const last = thread.turns.at(-1)?.id ?? null;
  for (const ask of [...control.live].reverse()) place(ask, last);
  return out;
}

type Thread = { key: number; turns: TurnView[]; asks: LiveAsk[]; order: ThreadItem[] };

// The card's title and its one menu item. A native <details>, like the carrier menu: a click or
// Enter opens it, Esc and a click outside close it. The title is the thread's first question, or
// "New conversation" while it has none. Past conversations are not listed here yet.
function ConversationMenu({
  title,
  canStartOver,
  onStartOver,
}: {
  title: string | null;
  canStartOver: boolean;
  onStartOver: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(ref);
  return (
    <details ref={ref} className="group relative min-w-0">
      <summary
        className={cn(
          "flex h-9 max-w-[24ch] cursor-pointer list-none items-center gap-1 rounded-lg px-2 text-body font-semibold text-foreground",
          "transition-colors duration-150 hover:bg-accent group-open:bg-accent [&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="min-w-0 truncate">{title ?? "New conversation"}</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div className="absolute top-full left-0 z-10 mt-1 grid w-56 gap-0.5 rounded-xl border border-border bg-card p-1.5 shadow-float motion-safe:animate-rise">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          disabled={!canStartOver}
          onClick={() => {
            if (ref.current) ref.current.open = false;
            onStartOver();
          }}
        >
          <SquarePen aria-hidden />
          New conversation
        </Button>
      </div>
    </details>
  );
}

// The agent as a floating card at the bottom right of the page (a phone: the modal sheet): the same
// chat in its compact layout, with the record the page is about as a chip. While the chip is on,
// each question carries that record as {table, id}; the label is only shown here. The thread loads
// on the first open and stays mounted after a close, so an answer still running is there when the
// card opens again.
export function AgentPanel({
  open,
  modal,
  expanded,
  onExpand,
  onClose,
  focus,
  config,
  suggestions,
  request,
}: {
  open: boolean;
  // A phone: the modal sheet. Laptop width: the floating card, the page still usable behind it.
  modal: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  onClose: () => void;
  focus?: PageFocus;
  config: AgentPanelConfig;
  suggestions: Suggestion[];
  // The newest ask to open; the question box takes the cursor each time its n changes.
  request: PanelRequest;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  // The ask whose text was already used: "New conversation" never brings it back into the box.
  const [spentDraft, setSpentDraft] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const focused = useRef("");
  const scrolled = useRef(-1);
  const reloaded = useRef(-1);
  // The conversation the thread shows, as the chat last told it (loaded turns or a new question).
  const shown = useRef<string | null>(null);
  const fresh = request.fresh === true;
  // Opened for a #card-<id> link: that card's conversation shows even if it was left.
  const toCard = request.scrollTo !== undefined;

  useEffect(() => {
    if (!open) return;
    // A card link whose card is not in the thread showing (the card was closed after New
    // conversation, say) reads the newest turns again, once per ask, so the card can be found.
    const reload =
      loading.current &&
      request.scrollTo !== undefined &&
      reloaded.current !== request.n &&
      document.getElementById(request.scrollTo) === null;
    if (loading.current && !reload) return;
    loading.current = true;
    if (reload) reloaded.current = request.n;
    const left = toCard ? null : leftConversation();
    void readRecent().then((recent) => {
      const t = recent.turns;
      const newest = t.at(-1)?.conversationId ?? null;
      // ?new=1 leaves the newest conversation the way "New conversation" does, so the next page
      // does not bring it back either.
      if (fresh && newest !== null) writeStored(`${LEFT}${newest}`);
      // A card link brings the left conversation back, so the next page shows it too.
      else if (toCard && leftConversation() !== null) clearStored();
      const turns = fresh || (left !== null && newest === left) ? [] : t;
      const read = { turns, asks: recent.asks, order: recent.order };
      if (reload) setThread((now) => ({ ...read, key: (now?.key ?? 0) + 1 }));
      // "New conversation" pressed while the read ran wins over the read.
      else setThread((now) => now ?? { ...read, key: 0 });
    });
  }, [open, fresh, toCard, request.n, request.scrollTo]);

  useEffect(() => {
    const want = `${request.n}:${nudge}`;
    if (!open || !thread || focused.current === want) return;
    const box = body.current?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    if (!box) return;
    focused.current = want;
    box.focus();
  }, [open, thread, request.n, nudge]);

  // #card-<id>: once the thread shows that card, it is scrolled into view, once per ask. A card not
  // in the thread (an older conversation's) leaves the thread where it is.
  useEffect(() => {
    if (!open || !thread || !request.scrollTo || scrolled.current === request.n) return;
    const card = document.getElementById(request.scrollTo);
    if (!card) return;
    scrolled.current = request.n;
    card.scrollIntoView?.({ block: "center" });
  }, [open, thread, request.n, request.scrollTo]);

  const asks = useAsks();
  const focusKey = focus ? `${focus.table}:${focus.id}` : null;
  const about = focus && focusKey !== dropped ? focus : null;
  const draft =
    request.draft !== undefined && request.n > spentDraft
      ? { text: request.draft, help: request.help, n: request.n }
      : undefined;

  function startOver() {
    // With nothing showing, any marker already stored stays as it is.
    if (shown.current !== null) writeStored(`${LEFT}${shown.current}`);
    setSpentDraft(request.n);
    setTitle(null);
    setThread((now) => ({ key: (now?.key ?? 0) + 1, turns: [], asks: now?.asks ?? [], order: now?.order ?? [] }));
    setNudge((n) => n + 1);
  }

  function onConversation(conversationId: string) {
    shown.current = conversationId;
    writeStored(conversationId);
  }

  const content = (
    <ViewerRoleProvider role={config.role}>
      <div className={cn("flex h-12 shrink-0 items-center gap-2 pl-2", modal ? "mt-1.5 pr-14" : "mt-1.5 pr-2")}>
        <h2 className="sr-only">Agent</h2>
        <ConversationMenu title={title} canStartOver={thread !== null && title !== null} onStartOver={startOver} />
        <Badge tone="neutral" className="rounded-md px-1.5 before:hidden">
          Beta
        </Badge>
        {modal ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={expanded ? "Shrink the agent" : "Expand the agent"}
              aria-pressed={expanded}
              onClick={() => onExpand(!expanded)}
            >
              {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Minimize the agent"
              // The dialog's own close, so it ends where every other way of closing does.
              onClick={(e) => e.currentTarget.closest("dialog")?.close()}
            >
              <Minus aria-hidden />
            </Button>
          </div>
        )}
      </div>
      {about ? (
        <div className="shrink-0 px-4 pb-1">
          <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-1 pr-1 pl-3 text-small text-foreground">
            <span className="min-w-0 truncate">About: {about.label}</span>
            <button
              type="button"
              aria-label={`Stop asking about ${about.label}`}
              onClick={() => {
                setDropped(focusKey);
                setNudge((n) => n + 1);
              }}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-foreground-2 transition-colors duration-150 hover:bg-card hover:text-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </span>
        </div>
      ) : null}
      <div ref={body} className="flex min-h-0 flex-1 flex-col">
        {thread ? (
          <AgentChat
            key={thread.key}
            compact
            initialTurns={thread.turns}
            streamMode={config.streamMode}
            auditorOn={config.auditorOn}
            timezone={config.timezone}
            stepThrough={config.stepThrough}
            viewer={config.viewer}
            disabledReason={config.disabledReason}
            suggestions={suggestions}
            title={config.greeting}
            intro={TRUST_LINE}
            draft={draft}
            documentsHref={config.documentsHref}
            focus={about ? { table: about.table, id: about.id } : null}
            onConversation={onConversation}
            onFirstQuestion={setTitle}
            asides={asidesOf(thread, asks)}
          />
        ) : (
          <LoadingState label="Opening your conversation" className="px-4 py-4" />
        )}
      </div>
    </ViewerRoleProvider>
  );

  return (
    <FloatingDialog
      id={PANEL_ID}
      open={open}
      modal={modal}
      onClose={onClose}
      label="Agent"
      expanded={expanded}
      closeLabel="Close the agent"
    >
      {content}
    </FloatingDialog>
  );
}
