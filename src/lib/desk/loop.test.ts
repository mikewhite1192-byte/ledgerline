import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import type { DiscoverInput } from "./discover";
import type { Handler, HandlerOutcome, Handlers } from "./handlers";
import { DESK_SOURCES, eventKey, type DeskSource } from "./keys";
import type { Line, OpenEvent } from "./log";
import { MAX_CARRIES, wakeDesk, type DeskStore } from "./loop";

// The loop on fakes: an in-memory log and lease, and handlers that answer what each test says. No
// database, no model, no clock but the one passed in.

const TENANT = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const SESSION: Session = { sub: `service:sweep:${TENANT}`, email: "", tenantId: TENANT };
const WAKE = "7c2d0e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const START = Date.parse("2026-11-02T15:00:00.000Z");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cardKey = (n: number) => eventKey("card_transaction", uuid(9000 + n));

const RANK: Record<string, number> = { seen: 0, claimed: 1, carried: 2 };
const TERMINAL = ["done", "failed", "skipped"];

// The log read back as the real readState does: an event's latest line decides its state, and an
// event with a terminal line is never open again.
function openEvents(lines: Line[]): OpenEvent[] {
  const byKey = new Map<string, Line[]>();
  for (const l of lines) {
    if (l.eventKey === null) continue;
    byKey.set(l.eventKey, [...(byKey.get(l.eventKey) ?? []), l]);
  }
  const out: OpenEvent[] = [];
  for (const [key, ls] of byKey) {
    const latest = ls[ls.length - 1];
    if (!(latest.kind in RANK) || ls.some((l) => TERMINAL.includes(l.kind))) continue;
    const carried = ls.filter((l) => l.kind === "carried");
    const last = carried[carried.length - 1];
    out.push({
      eventKey: key,
      source: latest.source as DeskSource,
      subjectId: key.includes("-") && !key.startsWith("sweep") ? key.slice(key.indexOf(":") + 1) : null,
      state: latest.kind as OpenEvent["state"],
      attempts: ls.filter((l) => l.kind === "claimed").length,
      carries: carried.length,
      threw: carried.filter((l) => l.detail.category === "threw").length,
      runId: last?.detail.runId ?? null,
      found: last?.detail.found ?? null,
      firstAt: ls[0].at,
    });
  }
  return out;
}

type Fake = DeskStore & {
  lines: Line[];
  lease: { token: string; until: string } | null;
  pending: { eventKey: string; source: DeskSource }[];
  discovered: DiscoverInput[];
  seenToday: number;
  spent: { wakeNanocents: number; dayNanocents: number };
  failState: boolean;
  clockStarts: string[];
  stateSince: string[];
};

function fakeStore(): Fake {
  const fake: Fake = {
    lines: [],
    lease: null,
    pending: [],
    discovered: [],
    seenToday: 0,
    spent: { wakeNanocents: 0, dayNanocents: 0 },
    failState: false,
    clockStarts: [],
    stateSince: [],
    async claim(input) {
      if (fake.lease && fake.lease.until >= input.nowIso) return null;
      fake.lease = { token: input.token, until: input.leaseUntilIso };
      // A row no wake has moved yet: no watermarks.
      return { zone: "America/Chicago", watermarks: { card_transactions: null, customer_payments: null, documents: null, load_events: null } };
    },
    async startClock(input) {
      if (fake.lease?.token === input.token) fake.clockStarts.push(input.nowIso);
    },
    async release(input) {
      if (fake.lease?.token === input.token) fake.lease = null;
    },
    async append(line) {
      if (line.kind === "done" && fake.lines.some((l) => l.kind === "done" && l.eventKey === line.eventKey)) return false;
      fake.lines.push(structuredClone(line));
      return true;
    },
    async discover(input) {
      fake.discovered.push(input);
      let n = 0;
      for (const e of fake.pending) {
        if (n >= input.budget) break;
        if (fake.lines.some((l) => l.eventKey === e.eventKey)) continue;
        await fake.append({ id: input.newId(), wakeId: input.wakeId, at: input.nowIso, kind: "seen", eventKey: e.eventKey, source: e.source, subjectId: null, by: input.by, detail: {} });
        n += 1;
      }
      return n;
    },
    async state(sinceStart) {
      fake.stateSince.push(sinceStart);
      if (fake.failState) throw new Error("connection reset by 10.0.0.12");
      return openEvents(fake.lines);
    },
    async seenSince() {
      return fake.seenToday;
    },
    async spend() {
      return fake.spent;
    },
  };
  return fake;
}

type Run = Handler["run"];

function handlersWith(run: Run, overrides: Partial<Record<DeskSource, Partial<Handler>>> = {}): Handlers {
  const out = {} as Handlers;
  for (const source of DESK_SOURCES) {
    out[source] = { switchOn: () => true, needsMs: 1_000, run, ...overrides[source] };
  }
  return out;
}

const done = (found = 1): HandlerOutcome => ({ outcome: "done", detail: { found } });

describe("wakeDesk", () => {
  const saved = structuredClone(flags.deskLoop);
  let now: number;
  let ids: number;
  let store: Fake;
  let logs: string[];

  const deps = (handlers: Handlers) => ({
    store,
    handlers,
    clock: () => new Date(now),
    newId: () => uuid((ids += 1)),
    log: (l: string) => logs.push(l),
  });
  const wake = (handlers: Handlers, wakeId = WAKE) =>
    wakeDesk(SESSION, { wakeId, by: "schedule", deadlineMs: now + 25_000 }, deps(handlers));
  const kinds = () => store.lines.map((l) => (l.eventKey ? `${l.kind} ${l.eventKey}` : l.kind));
  const ofKind = (kind: string) => store.lines.filter((l) => l.kind === kind);

  beforeEach(() => {
    flags.deskLoop.enabled = true;
    flags.deskLoop.armed = true;
    flags.deskLoop.startDate = "2026-10-31";
    Object.assign(flags.deskLoop.limits, saved.limits);
    now = START;
    ids = 0;
    store = fakeStore();
    logs = [];
  });

  afterEach(() => {
    flags.deskLoop.enabled = saved.enabled;
    flags.deskLoop.armed = saved.armed;
    flags.deskLoop.startDate = saved.startDate;
    Object.assign(flags.deskLoop.limits, saved.limits);
  });

  it("refuses when switched off, and touches nothing", async () => {
    flags.deskLoop.enabled = false;
    const claim = vi.spyOn(store, "claim");
    await expect(wake(handlersWith(async () => done()))).resolves.toEqual({ ok: false, category: "disabled" });
    expect(claim).not.toHaveBeenCalled();
    expect(store.lines).toEqual([]);
  });

  it("refuses a wake id that is not a uuid, and limits that are not whole and positive", async () => {
    await expect(wake(handlersWith(async () => done()), "wake-1")).resolves.toEqual({ ok: false, category: "bad_request" });
    flags.deskLoop.limits.eventsPerWake = 0;
    await expect(wake(handlersWith(async () => done()))).resolves.toEqual({ ok: false, category: "not_configured" });
    flags.deskLoop.limits.eventsPerWake = 2.5;
    await expect(wake(handlersWith(async () => done()))).resolves.toEqual({ ok: false, category: "not_configured" });
    expect(store.lines).toEqual([]);
  });

  it("starts the panel's clock only on an armed wake on or after the start date", async () => {
    await wake(handlersWith(async () => done()));
    flags.deskLoop.armed = false;
    await wake(handlersWith(async () => done()), uuid(8001));
    flags.deskLoop.armed = true;
    flags.deskLoop.startDate = "2026-11-03";
    await wake(handlersWith(async () => done()), uuid(8002));
    expect(store.clockStarts).toEqual([new Date(START).toISOString()]);
  });

  it("starts the loop at the carrier's own midnight on the start date, not UTC's", async () => {
    // Chicago is on CST from Nov 1, so its midnight on Nov 2 is 06:00 UTC.
    flags.deskLoop.startDate = "2026-11-02";
    now = Date.parse("2026-11-02T03:00:00.000Z");
    await wake(handlersWith(async () => done()));
    expect(store.clockStarts).toEqual([]);
    const start = "2026-11-02T06:00:00.000Z";
    expect(store.discovered[0]).toMatchObject({
      startInstant: start,
      watermarks: { card_transactions: start, customer_payments: start },
    });
    expect(store.stateSince).toEqual([start]);
    now = Date.parse(start);
    await wake(handlersWith(async () => done()), uuid(8001));
    expect(store.clockStarts).toEqual([start]);
  });

  it("answers busy under another wake's live lease, and writes nothing", async () => {
    store.lease = { token: uuid(7777), until: new Date(START + 30_000).toISOString() };
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(out).toMatchObject({ ok: true, status: "busy", reason: null });
    expect(store.lines).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(store.lease?.token).toBe(uuid(7777));
  });

  it("unarmed, writes what it would do as skipped lines and runs nothing", async () => {
    flags.deskLoop.armed = false;
    store.pending = [
      { eventKey: cardKey(1), source: "card_transaction" },
      { eventKey: "sweep:2026-11-02", source: "sweep" },
    ];
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(out.ok && out.counts).toEqual({ seen: 2, claimed: 0, done: 0, carried: 0, skipped: 2, failed: 0, left: 0 });
    expect(store.lines[0]).toMatchObject({ kind: "wake", detail: { category: "unarmed" } });
    expect(ofKind("skipped").map((l) => l.detail)).toEqual([{ category: "unarmed" }, { category: "unarmed" }]);
    expect(ofKind("claimed")).toEqual([]);
    expect(store.lease).toBeNull();
  });

  it("armed, claims each piece of work, runs it and records the outcome, then sleeps and gives the lease back", async () => {
    store.pending = [
      { eventKey: cardKey(1), source: "card_transaction" },
      { eventKey: cardKey(2), source: "card_transaction" },
    ];
    const run = vi.fn(async () => done(2));
    const out = await wake(handlersWith(run));
    expect(run).toHaveBeenCalledTimes(2);
    expect(kinds()).toEqual([
      "wake",
      `seen ${cardKey(1)}`,
      `seen ${cardKey(2)}`,
      `claimed ${cardKey(1)}`,
      `done ${cardKey(1)}`,
      `claimed ${cardKey(2)}`,
      `done ${cardKey(2)}`,
      "sleep",
    ]);
    expect(out).toMatchObject({ ok: true, wakeId: WAKE, status: "done", reason: "no_work" });
    expect(ofKind("sleep")[0].detail).toEqual({ found: 2, category: "no_work" });
    expect(store.lines.every((l) => l.wakeId === WAKE && l.by === "schedule")).toBe(true);
    expect(store.lease).toBeNull();
    // Discovery's share and the carrier's clock: 09:00 in Chicago on Nov 2.
    expect(store.discovered[0]).toMatchObject({ budget: 20, startDate: "2026-10-31", nowLocal: { date: "2026-11-02", hour: 9 } });
  });

  it("skips work whose own agent is switched off, without calling it", async () => {
    store.pending = [{ eventKey: "sweep:2026-11-02", source: "sweep" }];
    const run = vi.fn(async () => done());
    await wake(handlersWith(run, { sweep: { switchOn: () => false } }));
    expect(run).not.toHaveBeenCalled();
    expect(ofKind("skipped").map((l) => l.detail)).toEqual([{ category: "switched_off" }]);
  });

  it("carries a piece of work that is still running to the next scheduled wake without a new try", async () => {
    store.pending = [{ eventKey: "sweep:2026-11-02", source: "sweep" }];
    const RUN = uuid(5555);
    const seen: OpenEvent[] = [];
    const run = vi
      .fn<Run>()
      .mockImplementationOnce(async (_s, e) => {
        seen.push(e);
        return { outcome: "running", detail: { runId: RUN, found: 1 } };
      })
      .mockImplementationOnce(async (_s, e) => {
        seen.push(e);
        return { outcome: "done", detail: { runId: RUN, found: 3 } };
      });
    const first = await wake(handlersWith(run));
    // Work carried on does not ask for another wake now: it waits for the next scheduled one.
    expect(first).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(first.ok && first.counts).toMatchObject({ carried: 1, left: 1 });
    now += 60_000;
    const second = await wake(handlersWith(run), uuid(8888));
    expect(second).toMatchObject({ ok: true, status: "done" });
    expect(ofKind("claimed")).toHaveLength(1);
    expect(ofKind("carried").map((l) => l.detail)).toEqual([{ runId: RUN, found: 1 }]);
    expect(ofKind("done").map((l) => l.detail)).toEqual([{ runId: RUN, found: 3 }]);
    expect(seen[1]).toMatchObject({ state: "carried", runId: RUN, found: 1, attempts: 1, carries: 1 });
  });

  it("leaves a piece of work whose try threw claimed, tries again, and gives up at the attempts cap", async () => {
    store.pending = [{ eventKey: cardKey(1), source: "card_transaction" }];
    const run = vi.fn<Run>(async () => {
      throw new TypeError("card 4111 failed for driver Ana");
    });
    for (let i = 0; i < 3; i++) {
      // A try that threw does not ask for another wake now: the next one is a later wake's.
      const out = await wake(handlersWith(run), uuid(100 + i));
      expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
      expect(out.ok && out.counts.left).toBe(0);
      now += 60_000;
    }
    expect(run).toHaveBeenCalledTimes(3);
    const last = await wake(handlersWith(run), uuid(200));
    expect(run).toHaveBeenCalledTimes(3);
    expect(last).toMatchObject({ ok: true, status: "done" });
    expect(ofKind("claimed")).toHaveLength(3);
    expect(ofKind("failed").map((l) => l.detail)).toEqual([{ category: "abandoned" }]);
    // The error's name reaches the process log; its text reaches neither the log nor a line.
    expect(logs).toContain(`desk handler tenant=${TENANT} wake=${uuid(100)} source=card_transaction error=typeerror`);
    expect(JSON.stringify(store.lines) + logs.join("\n")).not.toMatch(/4111|Ana/);
  });

  it("still asks for another wake for other work left after a try that threw", async () => {
    flags.deskLoop.limits.eventsPerWake = 2;
    store.pending = [1, 2, 3].map((n) => ({ eventKey: cardKey(n), source: "card_transaction" as const }));
    const run = vi
      .fn<Run>()
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementation(async () => done());
    const out = await wake(handlersWith(run));
    expect(run).toHaveBeenCalledTimes(2);
    // The third card is not found yet, so the wake asks for another; the one that threw is not left.
    expect(out).toMatchObject({ ok: true, status: "more", reason: "events_per_wake" });
    expect(out.ok && out.counts.left).toBe(0);
  });

  it("keeps an event closed once it is done, whatever a late wake writes after it", async () => {
    const key = "sweep:2026-11-02";
    const base = { wakeId: uuid(1), eventKey: key, source: "sweep" as const, subjectId: null, by: "schedule" as const };
    const at = (ms: number) => new Date(START - ms).toISOString();
    store.lines.push({ ...base, id: uuid(2), at: at(3_600_000), kind: "seen", detail: {} });
    store.lines.push({ ...base, id: uuid(3), at: at(3_600_000), kind: "claimed", detail: {} });
    store.lines.push({ ...base, id: uuid(4), at: at(3_000_000), kind: "done", detail: { runId: uuid(4444) } });
    // A wake that froze at the route's limit thaws and records its old try as still running.
    store.lines.push({ ...base, id: uuid(5), wakeId: uuid(6), at: at(60_000), kind: "carried", detail: { runId: uuid(4444) } });
    ids = 100;
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(out.ok && out.counts).toMatchObject({ claimed: 0, done: 0, failed: 0, left: 0 });
  });

  it("asks for no other wake now after a wake that only carried work on, even with work behind it", async () => {
    const key = "sweep:2026-11-02";
    const at = new Date(START - 3_600_000).toISOString();
    const base = { wakeId: uuid(1), at, eventKey: key, source: "sweep" as const, subjectId: null, by: "schedule" as const };
    store.lines.push({ ...base, id: uuid(2), kind: "seen", detail: {} });
    store.lines.push({ ...base, id: uuid(3), kind: "claimed", detail: {} });
    store.lines.push({ ...base, id: uuid(4), kind: "carried", detail: { runId: uuid(4444) } });
    store.lines.push({ ...base, id: uuid(5), eventKey: cardKey(1), source: "card_transaction", kind: "seen", detail: {} });
    ids = 100;
    // The carried piece comes back running after the whole slice (a model that is down), so the
    // card behind it is not reached.
    const run = vi.fn<Run>(async () => {
      now += 25_000;
      return { outcome: "running", detail: { runId: uuid(4444) } };
    });
    const out = await wake(handlersWith(run));
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, status: "done", reason: "deadline" });
    expect(out.ok && out.counts).toMatchObject({ seen: 0, done: 0, carried: 1, left: 2 });
  });

  it("gives up a carried piece of work whose tries keep throwing, at maxAttempts, keeping its run", async () => {
    const key = "sweep:2026-11-02";
    const at = new Date(START - 3_600_000).toISOString();
    const base = { wakeId: uuid(1), at, eventKey: key, source: "sweep" as const, subjectId: null, by: "schedule" as const };
    store.lines.push({ ...base, id: uuid(2), kind: "seen", detail: {} });
    store.lines.push({ ...base, id: uuid(3), kind: "claimed", detail: {} });
    store.lines.push({ ...base, id: uuid(4), kind: "carried", detail: { runId: uuid(4444), found: 2 } });
    ids = 100;
    const seen: OpenEvent[] = [];
    const run = vi.fn<Run>(async (_s, e) => {
      seen.push(structuredClone(e));
      throw new TypeError("run 4444 failed for driver Ana");
    });
    for (let i = 0; i < flags.deskLoop.limits.maxAttempts; i++) {
      const out = await wake(handlersWith(run), uuid(300 + i));
      expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
      expect(out.ok && out.counts).toMatchObject({ carried: 0, failed: 0, left: 0 });
      now += 15 * 60_000;
    }
    // Each try went on with the same run and what it had found, never a new try.
    expect(seen.map((e) => [e.state, e.runId, e.found, e.attempts, e.threw])).toEqual([
      ["carried", uuid(4444), 2, 1, 0],
      ["carried", uuid(4444), 2, 1, 1],
      ["carried", uuid(4444), 2, 1, 2],
    ]);
    const last = await wake(handlersWith(run), uuid(400));
    expect(run).toHaveBeenCalledTimes(3);
    expect(last).toMatchObject({ ok: true, status: "done" });
    expect(ofKind("claimed")).toHaveLength(1);
    expect(ofKind("carried").map((l) => l.detail)).toEqual([
      { runId: uuid(4444), found: 2 },
      ...Array.from({ length: 3 }, () => ({ runId: uuid(4444), found: 2, category: "threw" })),
    ]);
    expect(ofKind("failed").map((l) => l.detail)).toEqual([{ runId: uuid(4444), category: "abandoned" }]);
    expect(JSON.stringify(store.lines) + logs.join("\n")).not.toMatch(/Ana/);
  });

  it("gives up a piece of work carried through too many wakes", async () => {
    const key = "sweep:2026-11-02";
    const at = new Date(START - 3_600_000).toISOString();
    const base = { wakeId: uuid(1), at, eventKey: key, source: "sweep" as const, subjectId: null, by: "schedule" as const };
    store.lines.push({ ...base, id: uuid(2), kind: "seen", detail: {} });
    store.lines.push({ ...base, id: uuid(3), kind: "claimed", detail: {} });
    for (let i = 0; i < MAX_CARRIES; i++) {
      store.lines.push({ ...base, id: uuid(10 + i), kind: "carried", detail: { runId: uuid(4444) } });
    }
    ids = 100;
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(run).not.toHaveBeenCalled();
    expect(ofKind("failed").map((l) => l.detail)).toEqual([{ runId: uuid(4444), category: "abandoned" }]);
    expect(out).toMatchObject({ ok: true, status: "done" });
  });

  it("stops before the next piece of work once the wake's model spend reaches its cap, and does not ask for more", async () => {
    store.pending = [1, 2, 3].map((n) => ({ eventKey: cardKey(n), source: "card_transaction" as const }));
    const run = vi.fn<Run>(async () => {
      store.spent = { wakeNanocents: flags.deskLoop.limits.wakeCents * NANOCENTS_PER_CENT, dayNanocents: 0 };
      return done();
    });
    const out = await wake(handlersWith(run));
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, status: "done", reason: "wake_cents" });
    expect(out.ok && out.counts.left).toBe(2);
    expect(ofKind("claimed")).toHaveLength(1);
  });

  it("stops before the next piece of work once the day's model spend reaches its cap", async () => {
    store.pending = [1, 2].map((n) => ({ eventKey: cardKey(n), source: "card_transaction" as const }));
    store.spent = { wakeNanocents: 0, dayNanocents: flags.deskLoop.limits.dayCents * NANOCENTS_PER_CENT };
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, status: "done", reason: "day_cents" });
    expect(ofKind("claimed")).toEqual([]);
  });

  it("takes at most eventsPerWake pieces of work and asks for another wake", async () => {
    flags.deskLoop.limits.eventsPerWake = 2;
    store.pending = [1, 2, 3].map((n) => ({ eventKey: cardKey(n), source: "card_transaction" as const }));
    const run = vi.fn(async () => done());
    const out = await wake(handlersWith(run));
    expect(store.discovered[0].budget).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ ok: true, status: "more", reason: "events_per_wake" });
    const next = await wake(handlersWith(run), uuid(8888));
    expect(run).toHaveBeenCalledTimes(3);
    expect(next).toMatchObject({ ok: true, status: "done", reason: "no_work" });
  });

  it("finds no more than the day's share, and says the day's share stopped it", async () => {
    flags.deskLoop.limits.eventsPerDay = 5;
    store.seenToday = 5;
    store.pending = [{ eventKey: cardKey(1), source: "card_transaction" }];
    const out = await wake(handlersWith(async () => done()));
    expect(store.discovered).toEqual([]);
    expect(out).toMatchObject({ ok: true, status: "done", reason: "events_per_day" });
    store.seenToday = 4;
    await wake(handlersWith(async () => done()), uuid(8888));
    expect(store.discovered[0].budget).toBe(1);
  });

  it("stops at the slice's deadline, and starts later work only when its time fits", async () => {
    store.pending = [1, 2].map((n) => ({ eventKey: cardKey(n), source: "card_transaction" as const }));
    const run = vi.fn<Run>(async () => {
      now += 12_000;
      return done();
    });
    // 20 s slice: after the first piece (12 s), 8 s are left, short of the 10 s the next one needs.
    const out = await wake(handlersWith(run, { card_transaction: { needsMs: 10_000 } }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, status: "more", reason: "deadline" });
    expect(out.ok && out.counts.left).toBe(1);
  });

  it("runs the agent's questions pass before sleeping: reasons only while armed and under the caps", async () => {
    const calls: { reasons: boolean; deadlineMs: number; before: number }[] = [];
    store.asks = async (input) => {
      calls.push({ reasons: input.reasons, deadlineMs: input.deadlineMs, before: ofKind("sleep").length });
    };
    await wake(handlersWith(vi.fn(async () => done())));
    expect(calls).toEqual([{ reasons: true, deadlineMs: expect.any(Number), before: 0 }]);
    // The wake's own deadline (the slice), never past the route's.
    expect(calls[0].deadlineMs).toBeGreaterThan(now);
    expect(calls[0].deadlineMs).toBeLessThanOrEqual(now + 25_000);
    expect(ofKind("sleep")).toHaveLength(1);

    flags.deskLoop.armed = false;
    await wake(handlersWith(vi.fn(async () => done())), uuid(900));
    expect(calls.at(-1)?.reasons).toBe(false);

    flags.deskLoop.armed = true;
    store.pending = [{ eventKey: cardKey(1), source: "card_transaction" }];
    store.spent = { wakeNanocents: 0, dayNanocents: flags.deskLoop.limits.dayCents * NANOCENTS_PER_CENT };
    const capped = await wake(handlersWith(vi.fn(async () => done())), uuid(901));
    expect(capped).toMatchObject({ ok: true, reason: "day_cents" });
    expect(calls.at(-1)?.reasons).toBe(false);
  });

  it("logs a questions pass that throws, by name only, and still sleeps and gives the lease back", async () => {
    store.asks = async () => {
      throw new Error("connection reset by 10.0.0.9");
    };
    const out = await wake(handlersWith(vi.fn(async () => done())));
    expect(out).toMatchObject({ ok: true, status: "done", reason: "no_work" });
    expect(ofKind("sleep")).toHaveLength(1);
    expect(store.lease).toBeNull();
    expect(logs.join(" ")).toContain("desk asks");
    expect(logs.join(" ")).not.toContain("10.0.0.9");
  });

  it("answers unavailable when the log does not read back, writes why, and gives the lease back", async () => {
    store.pending = [{ eventKey: cardKey(1), source: "card_transaction" }];
    store.failState = true;
    const run = vi.fn(async () => done());
    await expect(wake(handlersWith(run))).resolves.toEqual({ ok: false, category: "unavailable" });
    expect(run).not.toHaveBeenCalled();
    expect(ofKind("sleep").map((l) => l.detail)).toEqual([{ category: "read_failed" }]);
    expect(store.lease).toBeNull();
    expect(logs.join("\n")).not.toContain("10.0.0.12");
  });

  it("answers unavailable when the lease cannot be read, and writes nothing", async () => {
    vi.spyOn(store, "claim").mockRejectedValueOnce(new Error("timeout"));
    await expect(wake(handlersWith(async () => done()))).resolves.toEqual({ ok: false, category: "unavailable" });
    expect(store.lines).toEqual([]);
  });
});
