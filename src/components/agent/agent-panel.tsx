"use client";

import { SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/brand/mark";
import { LoadingState } from "@/components/app/states";
import { ViewerRoleProvider } from "@/components/app/viewer-role";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { TurnView } from "@/lib/agent/view";
import type { Role } from "@/lib/roles";
import type { PageFocus } from "./page-focus";
import type { Viewer } from "./proposal-card-from";
import { AgentChat } from "./turn-view";

// What the page's server read for the chat, the same settings Home passes its own chat.
export type AgentPanelConfig = {
  streamMode: "sse" | "poll";
  auditorOn: boolean;
  stepThrough: boolean;
  timezone: string;
  viewer: Viewer;
  role: Role;
  disabledReason?: string;
};

export const PANEL_ID = "agent-panel";

// The conversation the panel shows, kept for this browser tab so the next page picks it up. An
// empty value means the person started a new one, so the next page does not bring the old one
// back. Storage can be blocked or full; then each page simply reads the newest conversation.
const STORE_KEY = "pc-conversation";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
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

// The caller's newest conversation. Anything but a clean 200 (the switch off, signed out, a slow
// or failed read) starts an empty thread: the panel never opens on an error.
async function readRecent(): Promise<TurnView[]> {
  try {
    const res = await fetch("/api/agent/recent", { cache: "no-store" });
    if (res.status !== 200) return [];
    const body = (await res.json()) as { turns?: unknown };
    return isTurnList(body.turns) ? body.turns : [];
  } catch {
    return [];
  }
}

type Thread = { key: number; turns: TurnView[] };

// The agent beside the page: the same chat as Home in its compact layout, with the record the page
// is about as a chip. While the chip is on, each question carries that record as {table, id}; the
// label is only shown here. The thread loads on the first open and stays mounted after a close, so
// an answer still running is there when the panel opens again.
export function AgentPanel({
  open,
  modal,
  onClose,
  focus,
  config,
  boxRequest,
}: {
  open: boolean;
  // A phone: the modal sheet. Laptop width: beside the page, which stays usable.
  modal: boolean;
  onClose: () => void;
  focus?: PageFocus;
  config: AgentPanelConfig;
  // Bumped each time the panel is asked to open; the question box takes the cursor then.
  boxRequest: number;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const focused = useRef("");

  useEffect(() => {
    if (!open || loading.current) return;
    loading.current = true;
    const turns = readStored() === "" ? Promise.resolve([]) : readRecent();
    // "New conversation" pressed while the read ran wins over the read.
    void turns.then((t) => setThread((now) => now ?? { key: 0, turns: t }));
  }, [open]);

  useEffect(() => {
    const want = `${boxRequest}:${nudge}`;
    if (!open || !thread || focused.current === want) return;
    const box = body.current?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    if (!box) return;
    focused.current = want;
    box.focus();
  }, [open, thread, boxRequest, nudge]);

  const focusKey = focus ? `${focus.table}:${focus.id}` : null;
  const about = focus && focusKey !== dropped ? focus : null;

  function startOver() {
    writeStored("");
    setThread((now) => ({ key: (now?.key ?? 0) + 1, turns: [] }));
    setNudge((n) => n + 1);
  }

  return (
    <Sheet
      id={PANEL_ID}
      open={open}
      onClose={onClose}
      label="Agent"
      side="right"
      modal={modal}
      closeLabel="Close the agent"
      className={modal ? "w-full sm:w-[420px]" : "z-40 w-[420px]"}
    >
      <ViewerRoleProvider role={config.role}>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border pr-14 pl-4">
          <Mark size={22} />
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-foreground">Agent</h2>
          <Button variant="ghost" size="sm" onClick={startOver} disabled={!thread}>
            <SquarePen aria-hidden />
            New conversation
          </Button>
        </div>
        {about ? (
          <div className="shrink-0 border-b border-border px-4 py-2">
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
              intro="Ask in plain words. Every number comes from your records, and nothing is paid or sent until you approve it."
              focus={about ? { table: about.table, id: about.id } : null}
              onConversation={writeStored}
            />
          ) : (
            <LoadingState label="Opening your conversation" className="px-4 py-4" />
          )}
        </div>
      </ViewerRoleProvider>
    </Sheet>
  );
}
