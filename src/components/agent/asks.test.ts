import { describe, expect, it } from "vitest";
import {
  askDraft,
  asksOf,
  DISMISSED_MAX,
  mergeAsks,
  nextPoll,
  POLL_MS,
  POLL_START,
  pollDelay,
  pollStops,
  readDismissed,
  SLOW_AFTER,
  SLOW_POLL_MS,
  writeDismissed,
  type LiveAsk,
  type PollState,
} from "./asks";

// The launcher's pure parts: the poll's schedule, the closed set in a storage that may throw, the
// reply's shape check, the newest-first merge, and the text "Ask a question" puts in the box.

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const ask = (over: Partial<LiveAsk> = {}): LiveAsk => ({
  id: A1,
  kind: "ask",
  proposalId: P1,
  proposalKind: "advance_payout",
  text: "All paperwork is in for load BR-L10230. Should I send Wesley Delgado the 70% advance, $640.00?",
  reason: null,
  createdAt: "2026-11-02T15:00:00.000Z",
  shownAt: "2026-11-02T15:00:00.000Z",
  ...over,
});

function memory(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    store: () => ({
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    }),
  };
}

describe("the poll schedule", () => {
  const run = (events: Parameters<typeof nextPoll>[1][]): PollState => events.reduce(nextPoll, POLL_START);

  it("looks every 30 seconds while the page shows, and not at all while it is hidden", () => {
    expect(pollDelay(POLL_START, true)).toBe(POLL_MS);
    expect(POLL_MS).toBe(30_000);
    expect(pollDelay(POLL_START, false)).toBeNull();
  });

  it("stretches to 120 seconds after 10 empty replies in a row, failures counting as empty", () => {
    const nine = run(Array.from({ length: SLOW_AFTER - 1 }, () => ({ kind: "reply" as const, fresh: 0 })));
    expect(pollDelay(nine, true)).toBe(POLL_MS);
    const ten = nextPoll(nine, { kind: "failed" });
    expect(SLOW_AFTER).toBe(10);
    expect(pollDelay(ten, true)).toBe(SLOW_POLL_MS);
    expect(SLOW_POLL_MS).toBe(120_000);
    expect(pollDelay(ten, false)).toBeNull();
  });

  it("goes back to 30 seconds on anything new and on any answer", () => {
    const slow = run(Array.from({ length: 12 }, () => ({ kind: "reply" as const, fresh: 0 })));
    expect(pollDelay(nextPoll(slow, { kind: "reply", fresh: 2 }), true)).toBe(POLL_MS);
    expect(pollDelay(nextPoll(slow, { kind: "answered" }), true)).toBe(POLL_MS);
  });

  it("stops for good once the switch is off, signed out or refused", () => {
    const stopped = nextPoll(POLL_START, { kind: "stop" });
    expect(pollDelay(stopped, true)).toBeNull();
    expect(pollDelay(nextPoll(stopped, { kind: "answered" }), true)).toBeNull();
    expect(pollDelay(nextPoll(stopped, { kind: "reply", fresh: 1 }), true)).toBeNull();
    expect([409, 401, 403].map(pollStops)).toEqual([true, true, true]);
    expect([200, 400, 500, 503].map(pollStops)).toEqual([false, false, false, false]);
  });
});

describe("the closed set", () => {
  const KEY = "asks:0123456789abcdef0123456789abcdef";

  it("is kept per carrier and person, and reads back what was written", () => {
    const m = memory();
    writeDismissed(KEY, new Set([A1, A2]), m.store);
    expect([...readDismissed(KEY, m.store)]).toEqual([A1, A2]);
    expect(readDismissed("asks:fedcba9876543210fedcba9876543210", m.store).size).toBe(0);
  });

  it("keeps only ids, the newest 50", () => {
    const m = memory({ [KEY]: JSON.stringify([A1, "not-an-id", 7, A2.toUpperCase()]) });
    expect([...readDismissed(KEY, m.store)]).toEqual([A1, A2]);
    const many = Array.from({ length: 60 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
    writeDismissed(KEY, new Set(many), m.store);
    const kept = JSON.parse(m.items.get(KEY) ?? "[]") as string[];
    expect(kept).toHaveLength(DISMISSED_MAX);
    expect(kept.at(-1)).toBe(many.at(-1));
  });

  it("is empty, and never throws, when the storage throws, holds junk or there is no key", () => {
    const throwing = () => {
      throw new Error("blocked");
    };
    expect(readDismissed(KEY, throwing).size).toBe(0);
    expect(() => writeDismissed(KEY, new Set([A1]), throwing)).not.toThrow();
    const full = () => ({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(readDismissed(KEY, full).size).toBe(0);
    expect(() => writeDismissed(KEY, new Set([A1]), full)).not.toThrow();
    expect(readDismissed(KEY, memory({ [KEY]: "{not json" }).store).size).toBe(0);
    expect(readDismissed(KEY, memory({ [KEY]: '{"a":1}' }).store).size).toBe(0);
    const m = memory();
    writeDismissed(undefined, new Set([A1]), m.store);
    expect(m.items.size).toBe(0);
    expect(readDismissed(undefined, m.store).size).toBe(0);
  });
});

describe("a reply's questions", () => {
  it("keeps only rows with the server's shape", () => {
    const good = ask({ reason: "Signed BOL came in at 6:10." });
    expect(asksOf([good])).toEqual([good]);
    expect(asksOf([{ ...good, extra: "ignored" }])).toEqual([good]);
    expect(asksOf([{ ...good, id: "x" }, { ...good, kind: "other" }, { ...good, text: "" }, { ...good, shownAt: "today" }, null])).toEqual([]);
    expect(asksOf([{ ...good, reason: 5 }])[0].reason).toBeNull();
    expect(asksOf("nope")).toEqual([]);
  });

  it("merges newest first, each id once with its latest copy", () => {
    const old = ask({ id: A1, shownAt: "2026-11-02T15:00:00.000Z" });
    const back = ask({ id: A1, shownAt: "2026-11-03T14:00:00.000Z" });
    const other = ask({ id: A2, shownAt: "2026-11-02T16:00:00.000Z" });
    expect(mergeAsks([old], [other]).map((a) => a.id)).toEqual([A2, A1]);
    expect(mergeAsks([old, other], [back]).map((a) => [a.id, a.shownAt])).toEqual([
      [A1, back.shownAt],
      [A2, other.shownAt],
    ]);
  });
});

describe("the text Ask a question puts in the box", () => {
  it("names the load when the question does, else the kind in words", () => {
    expect(askDraft(ask())).toBe("About load BR-L10230: ");
    expect(askDraft(ask({ text: "Load BR-1042 is ready to bill. Should I post its $1,250.00 invoice?" }))).toBe(
      "About load BR-1042: ",
    );
    expect(askDraft(ask({ text: "Should I send Dana Reyes an advance of $1,400.00?" }))).toBe("About an advance: ");
    expect(askDraft(ask({ text: "I drafted a weekly settlement for Dana Reyes, $900.00. Approve?", proposalKind: "settlement_approve" }))).toBe(
      "About a weekly settlement: ",
    );
  });
});
