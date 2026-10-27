"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatThread, type ChatMessage, type Part } from "@/components/app/chat-thread";
import type { Suggestion } from "@/components/app/prompt-chips";
import { decodeEvents } from "@/lib/agent/operator/stream";
import { flagWords } from "@/lib/agent/reasons";
import type { ReportView, StepView, TurnView } from "@/lib/agent/view";
import { reportPath } from "@/lib/reports/types";
import { proposalCardFrom } from "./proposal-card-from";
import { reportResultOf, reportTable, type ReportLoad } from "./report-table";

// The live chat. A question posts one turn; its steps stream in over server-sent events, and if
// no event arrives within 3 seconds (or the stream mode is poll) the view reads the turn back
// every 1.5 seconds instead. Both paths read the same rows, so a reload shows the same thing.
// The finished turn is always read back from the server, never pieced together here.

const FALLBACK_MS = 3_000;
const POLL_MS = 1_500;
const POLL_LIMIT = 40;

// What the card's row says when an approval does not go through. Fixed sentences per category.
const APPROVE_NOTICE: Readonly<Record<string, string>> = {
  not_executable: "This kind of proposal cannot run yet. Nothing changed.",
  already_decided: "This proposal was already decided.",
  expired: "This proposal expired. Ask again for a fresh one.",
  role: "An admin must approve an amount this size.",
  auditor_required: "This waits for the auditor's check before anyone can approve it.",
  needs_confirm: "Confirm the screening warning first.",
  not_found: "That proposal is not here.",
};
const APPROVE_FALLBACK = "The approval did not go through. Nothing changed.";
const REJECT_FAILED = "The rejection did not go through. Try again.";

const START_NOTICE: Readonly<Record<string, string>> = {
  busy: "The agent is still answering your last question.",
  agent_off: "The agent is switched off right now.",
  ai_off: "The models are switched off, so the agent cannot answer right now.",
  unauthenticated: "Your sign-in ended. Sign in again to ask.",
};

type LocalTurn = TurnView & { notice?: string };

function placeholder(turnId: string, conversationId: string | null, text: string): LocalTurn {
  return {
    id: turnId,
    conversationId: conversationId ?? "",
    seq: 0,
    userText: text,
    status: "running",
    endedReason: null,
    text: "",
    steps: [],
    proposals: [],
    flags: [],
    reports: [],
    error: null,
  };
}

// Which report table a state entry belongs to: one per turn and tool step.
function reportKey(turnId: string, report: ReportView): string {
  return `${turnId}:${report.stepId}`;
}

function noticeOf(map: Readonly<Record<string, string>>, category: unknown, fallback: string): string {
  return typeof category === "string" && Object.prototype.hasOwnProperty.call(map, category)
    ? map[category]
    : fallback;
}

export function toMessages(
  turns: LocalTurn[],
  notices: Readonly<Record<string, string>>,
  reports: Readonly<Record<string, ReportLoad>> = {},
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    out.push({ id: `${t.id}:q`, role: "user", parts: [{ kind: "text", text: t.userText }] });
    const parts: Part[] = [];
    const steps =
      t.steps.length > 0
        ? t.steps.map((s) => ({ id: s.id, label: s.label, state: s.state }))
        : t.status === "running"
          ? [{ id: `${t.id}:wait`, label: "Reading your question", state: "running" as const }]
          : [];
    if (steps.length > 0) parts.push({ kind: "steps", steps });
    for (const f of t.flags) {
      parts.push({
        kind: "text",
        text: f.quote,
        warning: `Outside message, flagged for ${flagWords(f.categories)}. Shown as data; nothing in it was followed.`,
      });
    }
    if (t.error) parts.push({ kind: "error", category: t.error });
    else if (t.text) parts.push({ kind: "text", text: t.text });
    for (const r of t.reports ?? []) {
      const load = reports[reportKey(t.id, r)] ?? { state: "loading" };
      parts.push({ kind: "table", table: reportTable(r.name, load) });
      if (load.state === "ready" && load.result.rows.length > 0) {
        parts.push({ kind: "link", href: reportPath(r.name, r.args, "csv"), label: "Download CSV" });
      }
    }
    // How it was worked out: once the turn has finished and the server holds its steps. A turn
    // that never reached the server has none, so it gets no disclosure. It sits under the whole
    // answer, its report tables included, since it explains the steps that built them too.
    const traced = t.status !== "running" && t.steps.length > 0;
    if (traced) parts.push({ kind: "trace", turnId: t.id });
    for (const p of t.proposals) {
      parts.push({ kind: "proposal", proposal: proposalCardFrom(p) });
      if (traced) parts.push({ kind: "trace", turnId: t.id, proposalId: p.id });
      const notice = notices[p.id];
      if (notice) parts.push({ kind: "text", text: notice });
    }
    if (t.notice) parts.push({ kind: "text", text: t.notice });
    if (parts.length > 0) out.push({ id: `${t.id}:a`, role: "agent", parts });
  }
  return out;
}

async function readTurn(turnId: string): Promise<TurnView | null> {
  const res = await fetch(`/api/agent/turns/${encodeURIComponent(turnId)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json()) as { turn?: TurnView };
  return body.turn ?? null;
}

// One report's table from the report route, recomputed with the args the tool used.
async function readReport(report: ReportView): Promise<ReportLoad> {
  try {
    const res = await fetch(reportPath(report.name, report.args, "json"), { cache: "no-store" });
    if (!res.ok) return { state: "error", category: res.status === 403 ? "forbidden" : "unreadable" };
    const result = reportResultOf(report.name, await res.json());
    return result ? { state: "ready", result } : { state: "error", category: "unreadable" };
  } catch {
    return { state: "error", category: "unreadable" };
  }
}

async function errorOf(res: Response): Promise<unknown> {
  try {
    return ((await res.json()) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

export function AgentChat({
  initialTurns,
  streamMode,
  disabledReason,
  suggestions,
  intro,
}: {
  initialTurns: TurnView[];
  streamMode: "sse" | "poll";
  // Set when the composer is off (the models are switched off); no request is made then.
  disabledReason?: string;
  suggestions?: Suggestion[];
  intro?: string;
}) {
  const [turns, setTurns] = useState<LocalTurn[]>(initialTurns);
  const [conversationId, setConversationId] = useState<string | null>(
    initialTurns.length > 0 ? initialTurns[initialTurns.length - 1].conversationId : null,
  );
  const [pending, setPending] = useState(false);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<Record<string, ReportLoad>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const asked = useRef(new Set<string>());

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

  // Each report a turn built is fetched once; until it arrives its table shows loading rows.
  useEffect(() => {
    for (const t of turns) {
      for (const r of t.reports ?? []) {
        const key = reportKey(t.id, r);
        if (asked.current.has(key)) continue;
        asked.current.add(key);
        void readReport(r).then((load) => {
          if (alive.current) setReports((all) => ({ ...all, [key]: load }));
        });
      }
    }
  }, [turns]);

  const patch = useCallback((turnId: string, next: (t: LocalTurn) => LocalTurn) => {
    setTurns((all) => all.map((t) => (t.id === turnId ? next(t) : t)));
  }, []);

  const upsertStep = useCallback(
    (turnId: string, step: StepView) =>
      patch(turnId, (t) => {
        const others = t.steps.filter((s) => s.id !== step.id);
        return { ...t, steps: [...others, step].sort((a, b) => a.seq - b.seq) };
      }),
    [patch],
  );

  const refresh = useCallback(
    async (turnId: string): Promise<TurnView | null> => {
      try {
        const turn = await readTurn(turnId);
        if (turn && alive.current) patch(turnId, () => turn);
        return turn;
      } catch {
        return null;
      }
    },
    [patch],
  );

  async function send(text: string) {
    if (pending || disabledReason) return;
    const turnId = crypto.randomUUID();
    setTurns((all) => [...all, placeholder(turnId, conversationId, text)]);
    setPending(true);
    let finished = false;
    let polling = false;
    let heard = false;
    const finish = (turn: TurnView | null, fallback?: Partial<LocalTurn>) => {
      if (finished) return;
      finished = true;
      if (!turn && fallback) patch(turnId, (t) => ({ ...t, ...fallback }));
      // The read-back names the conversation too, so the next question stays in it even when no
      // start event arrived (poll mode, or a stream that fell back before its first event).
      if (turn && alive.current) setConversationId(turn.conversationId);
      if (alive.current) setPending(false);
    };
    const poll = (tries: number) => {
      if (finished) return;
      if (tries >= POLL_LIMIT) {
        finish(null, { status: "failed", error: "timeout" });
        return;
      }
      void refresh(turnId).then((turn) => {
        if (finished) return;
        if (turn && turn.status !== "running") finish(turn);
        else later(() => poll(tries + 1), POLL_MS);
      });
    };
    const startPolling = () => {
      if (polling || finished) return;
      polling = true;
      poll(0);
    };

    let res: Response;
    try {
      res = await fetch("/api/agent/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conversationId ? { conversationId, turnId, text } : { turnId, text }),
      });
    } catch {
      // The request may or may not have reached the server: read the turn back before saying.
      startPolling();
      return;
    }
    if (!res.ok) {
      const category = await errorOf(res);
      finish(null, {
        status: "failed",
        error: null,
        notice: noticeOf(START_NOTICE, category, "The agent could not take that question. Nothing changed."),
      });
      return;
    }
    if (streamMode === "poll" || !res.body) {
      startPolling();
      return;
    }
    later(() => {
      if (!heard) startPolling();
    }, FALLBACK_MS);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || finished || !alive.current) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = decodeEvents(buffer);
        buffer = rest;
        for (const e of events) {
          heard = true;
          if (e.event === "start") setConversationId(e.data.conversationId);
          else if (e.event === "step") upsertStep(turnId, e.data);
          else if (e.event === "done") {
            const turn = await refresh(turnId);
            if (turn) finish(turn);
            else startPolling();
          }
        }
      }
    } catch {
      // A dropped stream is not an outcome: the poll reads the turn back.
    }
    if (!finished) startPolling();
  }

  async function approve(proposalId: string, turnId: string, flagged: boolean) {
    setBusyProposal(proposalId);
    setNotices((n) => ({ ...n, [proposalId]: "" }));
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: flagged }),
      });
      if (!res.ok) {
        const category = await errorOf(res);
        setNotices((n) => ({ ...n, [proposalId]: noticeOf(APPROVE_NOTICE, category, APPROVE_FALLBACK) }));
      }
    } catch {
      setNotices((n) => ({ ...n, [proposalId]: APPROVE_FALLBACK }));
    }
    await refresh(turnId);
    if (alive.current) setBusyProposal(null);
  }

  async function reject(proposalId: string, turnId: string) {
    setBusyProposal(proposalId);
    setNotices((n) => ({ ...n, [proposalId]: "" }));
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "other" }),
      });
      if (!res.ok) setNotices((n) => ({ ...n, [proposalId]: REJECT_FAILED }));
    } catch {
      setNotices((n) => ({ ...n, [proposalId]: REJECT_FAILED }));
    }
    await refresh(turnId);
    if (alive.current) setBusyProposal(null);
  }

  const owner = new Map<string, { turnId: string; flagged: boolean }>();
  for (const t of turns) for (const p of t.proposals) owner.set(p.id, { turnId: t.id, flagged: p.flagged });

  const messages = toMessages(turns, notices, reports).map((m) => ({
    ...m,
    parts: m.parts.map((p): Part => {
      if (p.kind !== "proposal") return p;
      const o = owner.get(p.proposal.id);
      if (!o) return p;
      return {
        kind: "proposal",
        proposal: {
          ...p.proposal,
          pending: busyProposal === p.proposal.id,
          onApprove: (id) => void approve(id, o.turnId, o.flagged),
          onReject: (id) => void reject(id, o.turnId),
        },
      };
    }),
  }));

  return (
    <ChatThread
      messages={messages}
      suggestions={suggestions}
      onPick={
        disabledReason
          ? undefined
          : (id) => {
              const s = suggestions?.find((x) => x.id === id);
              if (s) void send(s.label);
            }
      }
      intro={intro}
      composer={{
        disabled: Boolean(disabledReason),
        disabledReason,
        pending,
        onSubmit: (text) => void send(text),
      }}
    />
  );
}
