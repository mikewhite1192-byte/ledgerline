import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { feedLine } from "@/lib/tms/read";
import { buildStateSummary } from "./summary";

// The dispatch feed line of the agent's summary (TMS-MIRROR, design-tms 4): one line while the
// mirror's switch is on, "not connected" with no connection, counts and codes only. Off, the
// summary never reads the mirror.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-31T20:00:00Z");
const CAP = 10_000;

const saved = flags.tmsSync.enabled;
afterEach(() => {
  flags.tmsSync.enabled = saved;
});

type Feed = { system: string; last_walk_completed_at: string | null; events_today: string; flagged: string };

function fakeCarrier(feed: Feed | null | "throws", seen: string[]): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      seen.push(sql);
      if (sql.includes("FROM tenants")) {
        return [{ id: SESSION.tenantId, slug: "blue-ridge", name: "Blue Ridge Freight", timezone: "America/Chicago" }] as T[];
      }
      if (sql.includes("FROM tms_connections")) {
        expect(params).toEqual(["2026-10-31"]);
        if (feed === "throws") throw new Error("connection reset by peer at 10.0.0.7");
        return (feed ? [feed] : []) as T[];
      }
      if (sql.includes("pay_configs")) return [] as T[];
      if (sql.includes("FROM conversations")) return [] as T[];
      if (sql.includes("FROM turns")) return [] as T[];
      if (sql.includes("FROM proposals p")) return [] as T[];
      if (sql.includes("FROM gateway_decisions")) return [] as T[];
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute() {
      throw new Error("the summary only reads");
    },
  };
}

const FEED: Feed = { system: "synthetic", last_walk_completed_at: "2026-10-31T19:20:00.000Z", events_today: "3", flagged: "1" };

describe("the dispatch feed line", () => {
  it("says the system, the last full pass in the carrier's zone, today's events and flagged loads", async () => {
    flags.tmsSync.enabled = true;
    const out = await buildStateSummary(fakeCarrier(FEED, []), SESSION, CONVERSATION, NOW, CAP);
    expect(out.text).toContain("\n\nDispatch feed:\nsynthetic demo, last full pass 2:20 PM, 3 events today, 1 flagged");
    // After the pay rules, before anything about the conversation.
    expect(out.text.indexOf("Dispatch feed:")).toBeGreaterThan(out.text.indexOf("Pay rules:"));
    expect(out.cents).toEqual([]);
  });

  it("says not connected when the carrier has no dispatch connection", async () => {
    flags.tmsSync.enabled = true;
    const out = await buildStateSummary(fakeCarrier(null, []), SESSION, CONVERSATION, NOW, CAP);
    expect(out.text).toContain("\n\nDispatch feed:\nnot connected");
  });

  it("says fixed words, never the error, when the feed cannot be read, and the summary still builds", async () => {
    flags.tmsSync.enabled = true;
    const out = await buildStateSummary(fakeCarrier("throws", []), SESSION, CONVERSATION, NOW, CAP);
    expect(out.text).toContain("\n\nDispatch feed:\nDispatch feed: not available");
    expect(out.text).not.toContain("connection reset");
    expect(out.text).not.toContain("10.0.0.7");
    expect(out.text).toContain("Pay rules:");
    expect(out.text).toContain("Time zone: America/Chicago");
  });

  it("never reads the mirror while the switch is off", async () => {
    flags.tmsSync.enabled = false;
    const seen: string[] = [];
    const out = await buildStateSummary(fakeCarrier(FEED, seen), SESSION, CONVERSATION, NOW, CAP);
    expect(out.text).not.toContain("Dispatch feed");
    expect(seen.some((sql) => sql.includes("tms_"))).toBe(false);
  });

  it("words a feed with no full pass and one event, and an unknown system plainly", () => {
    expect(feedLine({ system: "synthetic", lastFullPassAt: null, eventsToday: 1, flaggedLoads: 0 }, "America/Chicago")).toBe(
      "synthetic demo, no full pass yet, 1 event today, 0 flagged",
    );
    expect(feedLine({ system: "other", lastFullPassAt: "2026-10-31T05:05:00.000Z", eventsToday: 0, flaggedLoads: 2 }, "America/Chicago")).toBe(
      "connected, last full pass 12:05 AM, 0 events today, 2 flagged",
    );
    expect(feedLine(null, "America/Chicago")).toBe("not connected");
  });
});
