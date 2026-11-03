import { kindInWords } from "@/lib/asks/words";
import { isUuid } from "@/lib/uuid";

// The agent's questions and told lines as the browser holds them (GET /api/agent/asks, and the
// asks on /api/agent/recent): how often the launcher asks for new ones, the questions this person
// closed with the x, and the text "Ask a question" puts in the box. Pure, no fetch here.

export type LiveAsk = {
  id: string;
  kind: "ask" | "told" | "digest";
  // Null only on a morning digest, which names no proposal and offers only Got it.
  proposalId: string | null;
  proposalKind: string | null;
  text: string;
  reason: string | null;
  createdAt: string;
  shownAt: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));

const textOr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

// One row of a reply, kept only when every field the bubble uses has the shape the server writes:
// an ask or a told line names its proposal, a morning digest names none.
function askOf(v: unknown): LiveAsk | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const text = textOr(r.text, 400);
  if (!isUuid(r.id) || text === null || !isIso(r.createdAt) || !isIso(r.shownAt)) return null;
  const base = { id: r.id.toLowerCase(), text, reason: textOr(r.reason, 200), createdAt: r.createdAt, shownAt: r.shownAt };
  if (r.kind === "digest") {
    if (r.proposalId !== null || r.proposalKind !== null) return null;
    return { ...base, kind: "digest", proposalId: null, proposalKind: null };
  }
  const proposalKind = textOr(r.proposalKind, 40);
  if (!isUuid(r.proposalId) || proposalKind === null) return null;
  if (r.kind !== "ask" && r.kind !== "told") return null;
  return {
    id: base.id,
    kind: r.kind,
    proposalId: r.proposalId.toLowerCase(),
    proposalKind,
    text,
    reason: textOr(r.reason, 200),
    createdAt: r.createdAt,
    shownAt: r.shownAt,
  };
}

export function asksOf(value: unknown): LiveAsk[] {
  if (!Array.isArray(value)) return [];
  return value.map(askOf).filter((a): a is LiveAsk => a !== null);
}

// The newest first (by when each showed), each id once; a later copy of an id replaces the older.
export function mergeAsks(held: readonly LiveAsk[], fresh: readonly LiveAsk[]): LiveAsk[] {
  const byId = new Map<string, LiveAsk>();
  for (const a of held) byId.set(a.id, a);
  for (const a of fresh) byId.set(a.id, a);
  return [...byId.values()].sort((x, y) =>
    x.shownAt < y.shownAt ? 1 : x.shownAt > y.shownAt ? -1 : x.id < y.id ? 1 : x.id > y.id ? -1 : 0,
  );
}

// The poll's schedule: every 30 seconds while the page shows, every 120 after 10 replies in a row
// with nothing new, back to 30 on anything new or any answer. Hidden, nothing is scheduled (the
// next look happens as the page shows again). Switched off, signed out or refused, it stops for
// good on this page.
export const POLL_MS = 30_000;
export const SLOW_POLL_MS = 120_000;
export const SLOW_AFTER = 10;

export type PollState = { stopped: boolean; empty: number };
export type PollEvent =
  | { kind: "reply"; fresh: number }
  | { kind: "failed" }
  | { kind: "stop" }
  | { kind: "answered" };

export const POLL_START: PollState = { stopped: false, empty: 0 };

export function nextPoll(state: PollState, event: PollEvent): PollState {
  if (state.stopped || event.kind === "stop") return { stopped: true, empty: state.empty };
  if (event.kind === "answered") return { stopped: false, empty: 0 };
  // A failed read is nothing new: it slows down like an empty one, and never stops the poll.
  if (event.kind === "failed" || event.fresh === 0) return { stopped: false, empty: state.empty + 1 };
  return { stopped: false, empty: 0 };
}

// Milliseconds to the next look, or null for none now.
export function pollDelay(state: PollState, visible: boolean): number | null {
  if (state.stopped || !visible) return null;
  return state.empty >= SLOW_AFTER ? SLOW_POLL_MS : POLL_MS;
}

// What a reply's status means for the schedule: the switch off (409 asks_off or agent_off, the
// shipped state), signed out or refused stop it; anything else unclear is a failed read.
export function pollStops(status: number): boolean {
  return status === 409 || status === 401 || status === 403;
}

// The questions this person closed with the x, kept in this browser under the key the server built (src/lib/asks/dismiss-key.ts).
// Storage can be blocked, full or cleared: every read and write is caught, and a cleared store
// shows the question again, which is safe. At most DISMISSED_MAX ids, the newest kept.
export const DISMISSED_MAX = 50;

type StorageOf = () => Pick<Storage, "getItem" | "setItem">;

export function readDismissed(key: string | undefined, storage: StorageOf): Set<string> {
  if (!key) return new Set();
  try {
    const v: unknown = JSON.parse(storage().getItem(key) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter(isUuid).map((id) => id.toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

export function writeDismissed(key: string | undefined, ids: ReadonlySet<string>, storage: StorageOf): void {
  if (!key) return;
  try {
    storage().setItem(key, JSON.stringify([...ids].slice(-DISMISSED_MAX)));
  } catch {
    // Nothing to do: the x still closes it on this page.
  }
}

// "About load BR-1042: " when the question names a load (the code wrote the words, so the load
// number is the record's own), else "About an advance: ".
const LOAD = /\b[Ll]oad ([A-Z0-9][A-Za-z0-9-]{0,38}[A-Za-z0-9])\b/;

export function askDraft(ask: Pick<LiveAsk, "text" | "proposalKind">): string {
  const load = LOAD.exec(ask.text)?.[1];
  if (load) return `About load ${load}: `;
  return ask.proposalKind === null ? "About the morning digest: " : `About ${kindInWords(ask.proposalKind)}: `;
}
