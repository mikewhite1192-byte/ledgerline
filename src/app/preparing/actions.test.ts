import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { VisitTicket } from "@/lib/auth/session";
import type { Queryable } from "@/lib/db";
import { buildCopyAction } from "./actions";

// The build action's last step: once the copy is marked ready, the copy's own pay check starts
// once, as the copy's session, while its switch is on and the copies' day has room; off, past the
// day, refused or throwing, the answer is still ready. A copy not built or not marked starts
// nothing. The visit read, the build, the purge, the ready mark, the sweep and the database are
// fakes; the story (src/lib/visit-copy/story.ts) is the real one.

const HOME = "00000000-0000-4000-8000-0000000000a1";
const COPY = "00000000-0000-4000-8000-0000000000c1";
const COPY_VISIT = "00000000-0000-4000-8000-0000000000c2";
const TICKET = "00000000-0000-4000-8000-0000000000b1";
const TOKEN: Session = { sub: "sub-judge", email: "judge@blueridge.example", tenantId: HOME };
const VISIT: VisitTicket = {
  token: TOKEN,
  ticketId: TICKET,
  copy: { tenantId: COPY, sessionId: COPY_VISIT, ready: false, deleted: false, expiresAt: "2026-11-03T20:00:00.000Z" },
};

const state = vi.hoisted(() => ({
  visit: null as unknown,
  done: true,
  ready: true,
  others: 0 as unknown,
  start: null as unknown,
  startThrows: false,
  startHangs: false,
  starts: [] as { session: unknown; input: unknown }[],
  counts: [] as { tenant: string; params: unknown[] }[],
}));

vi.mock("@/lib/auth/session", () => ({
  getPreparingVisit: async () => state.visit,
  visitLanding: async () => "/",
}));
vi.mock("@/lib/auth/demo-visit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/demo-visit")>()),
  markCopyReady: async () => state.ready,
}));
vi.mock("@/lib/seed/reset", () => ({ demoCarrierOf: async () => ({ slug: "blue-ridge" }) }));
vi.mock("@/lib/visit-copy/build", () => ({
  buildCopySlice: async () => ({
    done: state.done,
    setup: false,
    tablesDone: state.done ? 10 : 4,
    tablesTotal: 10,
    statements: 1,
    ms: 1,
  }),
}));
vi.mock("@/lib/visit-copy/purge", () => ({ purgeExpired: async () => ({ purged: 0, gone: 0, failed: 0 }) }));
vi.mock("@/lib/sweep/run", () => ({
  startSweep: async (session: unknown, input: unknown) => {
    state.starts.push({ session, input });
    if (state.startThrows) throw new Error("boom");
    if (state.startHangs) return new Promise(() => {});
    return state.start;
  },
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({
    withTenant: async <T,>(tenant: string, fn: (q: Queryable) => Promise<T>) => {
      const q = {
        query: async (_sql: string, params: unknown[] = []) => {
          state.counts.push({ tenant, params });
          return [{ n: state.others }];
        },
        execute: async () => 0,
      } as unknown as Queryable;
      return fn(q);
    },
  }),
}));

const saved = { visitCopies: { ...flags.visitCopies }, sweepEnabled: flags.sweepEnabled };

beforeEach(() => {
  Object.assign(state, {
    visit: VISIT,
    done: true,
    ready: true,
    others: 0,
    start: { ok: true, runId: COPY_VISIT, existing: false },
    startThrows: false,
  startHangs: false,
    starts: [],
    counts: [],
  });
  Object.assign(flags.visitCopies, { enabled: true, startSweep: true, sweepDayCents: 3000 });
  flags.sweepEnabled = true;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(flags.visitCopies, saved.visitCopies);
  flags.sweepEnabled = saved.sweepEnabled;
  vi.restoreAllMocks();
});

describe("buildCopyAction's pay check", () => {
  it("starts one run in the copy as the copy's session, its id the copy's own visit row", async () => {
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(state.starts).toEqual([
      {
        session: {
          sub: `visit:${TICKET}`,
          email: TOKEN.email,
          tenantId: COPY,
          demoSessionId: COPY_VISIT,
          visitTicketId: TICKET,
          visitHome: { tenantId: HOME, sub: TOKEN.sub },
        },
        input: { runId: COPY_VISIT, trigger: "button" },
      },
    ]);
    // The day's count is read in the demo carrier, leaving this visit out, on the database clock.
    expect(state.counts).toEqual([{ tenant: HOME, params: [TICKET, null] }]);
    expect(console.info).toHaveBeenCalledWith(`visit copy: sweep ${COPY_VISIT} started`);
  });

  it("starts nothing while its switch or the sweep's is off, and is still ready", async () => {
    for (const off of [
      () => (flags.visitCopies.startSweep = false),
      () => (flags.sweepEnabled = false),
    ]) {
      off();
      expect(await buildCopyAction()).toEqual({ state: "ready" });
      flags.visitCopies.startSweep = true;
      flags.sweepEnabled = true;
    }
    expect(state.starts).toEqual([]);
    expect(state.counts).toEqual([]);
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped off");
  });

  it("starts nothing once the day's copies at their whole run cap would pass the day's cap", async () => {
    const run = Math.max(flags.fanoutLimits.runCapCents, flags.sweepLimits.maxRunCents);
    // Room for exactly one more run fits; one fewer does not.
    state.others = Math.floor(3000 / run) - 1;
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(state.starts).toHaveLength(1);
    state.others = Math.floor(3000 / run);
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(state.starts).toHaveLength(1);
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped day_full");
  });

  it("starts nothing on a day cap that is not a whole positive number, or a count that cannot be read", async () => {
    for (const cents of [0, -1, Number.NaN, 1.5]) {
      flags.visitCopies.sweepDayCents = cents;
      expect(await buildCopyAction()).toEqual({ state: "ready" });
    }
    flags.visitCopies.sweepDayCents = 3000;
    state.others = "7";
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(state.starts).toEqual([]);
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped not_configured");
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped failed (DbError)");
  });

  it("is still ready when the sweep refuses or throws", async () => {
    state.start = { ok: false, category: "no_open_period" };
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped refused no_open_period");
    state.startThrows = true;
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped failed (Error)");
    expect(state.starts).toHaveLength(2);
  });

  it("is ready after five seconds when the start has not answered", async () => {
    vi.useFakeTimers();
    try {
      state.startHangs = true;
      const answer = buildCopyAction();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await answer).toEqual({ state: "ready" });
      expect(console.info).toHaveBeenCalledWith("visit copy: sweep skipped timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a replayed start kept the copy's one run", async () => {
    state.start = { ok: true, runId: COPY_VISIT, existing: true };
    expect(await buildCopyAction()).toEqual({ state: "ready" });
    expect(console.info).toHaveBeenCalledWith(`visit copy: sweep ${COPY_VISIT} kept`);
  });

  it("starts nothing while the copy is still building, or when it could not be marked ready", async () => {
    state.done = false;
    expect(await buildCopyAction()).toMatchObject({ state: "building" });
    state.done = true;
    state.ready = false;
    expect(await buildCopyAction()).toEqual({ state: "failed" });
    expect(state.starts).toEqual([]);
  });
});
