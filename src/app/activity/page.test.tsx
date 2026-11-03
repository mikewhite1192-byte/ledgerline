// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Param, type Queryable } from "@/lib/db";
import ActivityPage from "./page";

// The /activity page on fixed rows through the real feed readers, with no database and a fixed
// clock: the lines in order with their words, the desk's last check-in and the pause, the Older
// link, the off state that reads nothing, and a read that fails showing as unreadable, never as a
// quiet day. Nothing here writes.

const TENANT = "11111111-2222-4333-8444-555555555555";
const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: TENANT };
const NOW = new Date(Date.UTC(2026, 10, 10, 15, 0, 0));
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), usePathname: () => "/activity" }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

const COLUMNS = {
  key: null,
  event: null,
  actor: null,
  cents: null,
  direction: null,
  title: null,
  kind: null,
  code: null,
  reason: null,
  n: null,
  limit_cents: null,
  day_cents: null,
  until_at: null,
  channel: null,
  system: null,
  once: null,
  record_table: null,
  record_id: null,
};

const FEED_ROWS = [
  {
    ...COLUMNS,
    at: "2026-11-10T14:59:00.000000Z",
    key: `money:${ID}:settled`,
    event: "money_settled",
    actor: "autopilot",
    cents: "12500",
    kind: "advance_payout",
    code: "confirmed",
    channel: "payment",
    system: "fuel_card_sim",
    once: "yes",
    record_table: "advances",
    record_id: ID,
  },
  {
    ...COLUMNS,
    at: "2026-11-10T14:58:00.000000Z",
    key: `proposal:${ID}:decided`,
    event: "proposal_decided",
    actor: "autopilot",
    cents: "12500",
    direction: "out",
    title: "Advance for Driver 7",
    kind: "advance_payout",
    code: "approved",
    limit_cents: "50000",
  },
  {
    ...COLUMNS,
    at: "2026-11-10T14:50:00.000000Z",
    key: `proposal:${ID}:proposed`,
    event: "proposal_proposed",
    actor: "agent",
    cents: "12500",
    direction: "out",
    title: "Advance for Driver 7",
    kind: "advance_payout",
  },
];

type Answer = (sql: string, params: Param[]) => unknown[];
let feedAnswer: Answer;
let reads: string[] = [];

function fakeQ(): Queryable {
  return {
    async query<R>(sql: string, params: Param[] = []) {
      reads.push(sql);
      let rows: unknown[];
      if (sql === "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()") {
        rows = [{ name: "Test Carrier", timezone: "America/Chicago" }];
      } else if (sql.startsWith("SELECT email, role FROM memberships")) {
        rows = [{ email: SESSION.email, role: "admin" }];
      } else if (sql.includes("FROM desk_log WHERE tenant_id = current_tenant_id() AND kind = 'sleep'")) {
        rows = [{ at: "2026-11-10T14:55:00.000000Z" }];
      } else if (sql.includes("FROM autopilot_state")) {
        rows = [{ paused_at: "2026-11-10T14:00:00.000000Z", paused_until: null, paused_by: "sub-test", revision: "7" }];
      } else if (sql.includes("UNION ALL")) {
        rows = feedAnswer(sql, params);
      } else {
        throw new Error(`unexpected read: ${sql.slice(0, 60)}`);
      }
      return rows as R[];
    },
    async execute() {
      throw new Error("the page writes nothing");
    },
  };
}

const saved = { ...flags.activityFeed };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  reads = [];
  flags.activityFeed.enabled = true;
  flags.activityFeed.pageSize = 50;
  feedAnswer = () => FEED_ROWS;
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => Promise<unknown>) => fn(fakeQ(), SESSION));
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(flags.activityFeed, saved);
  cleanup();
});

const page = async (search: Record<string, string> = {}) => render(await ActivityPage({ searchParams: Promise.resolve(search) }));

describe("/activity", () => {
  it("lists the steps newest first, in words, with the desk's last check-in and the pause", async () => {
    await page();
    expect(screen.getByRole("heading", { level: 1, name: "Live feed" })).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Live feed lines" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("span")?.textContent)).toEqual([
      "Paid and confirmed: Fuel card load, $125.00",
      "Autopilot approved Advance for Driver 7, $125.00, within its limit of $500.00",
      "Agent proposed Advance for Driver 7, $125.00 out",
    ]);
    expect(items[0].querySelector("time")?.textContent).toBe("Nov 10, 2026, 8:59 AM CST");
    expect(within(items[0]).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe(`/records/advances/${ID}`);
    expect(screen.getByText(/The desk last checked in Nov 10, 2026, 8:55 AM CST\. The autopilot is paused\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Older" })).toBeNull();
    const feed = screen.getByRole("list", { name: "Live feed lines" }).textContent ?? "";
    expect(feed).not.toContain("desk@example.test");
    expect(feed).not.toContain("sub-test");
  });

  it("offers Older when there is more, and reads the page the cursor names without the live refresh", async () => {
    flags.activityFeed.pageSize = 2;
    let asked: Param[] = [];
    feedAnswer = (_sql, params) => {
      asked = params;
      return FEED_ROWS;
    };
    await page();
    expect(asked).toEqual([3, "9999-12-31T00:00:00.000000Z", "~"]);
    const older = screen.getByRole("link", { name: "Older" }).getAttribute("href") ?? "";
    expect(decodeURIComponent(older)).toBe(`/activity?before=2026-11-10T14:58:00.000000Z|proposal:${ID}:decided`);
    cleanup();

    await page({ before: `2026-11-10T14:58:00.000000Z|proposal:${ID}:decided` });
    expect(asked).toEqual([3, "2026-11-10T14:58:00.000000Z", `proposal:${ID}:decided`]);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByRole("link", { name: "Newest" }).getAttribute("href")).toBe("/activity");
  });

  it("reads the first page for a cursor that does not read", async () => {
    let asked: Param[] = [];
    feedAnswer = (_sql, params) => {
      asked = params;
      return [];
    };
    await page({ before: "'; DROP TABLE proposals; --" });
    expect(asked).toEqual([51, "9999-12-31T00:00:00.000000Z", "~"]);
    expect(screen.getByText("Nothing has happened with money yet.")).toBeTruthy();
  });

  it("shows the off state and reads no feed while the switch is off", async () => {
    flags.activityFeed.enabled = false;
    await page();
    expect(screen.getByText("Live feed is off for this carrier")).toBeTruthy();
    expect(reads.some((sql) => sql.includes("UNION ALL") || sql.includes("desk_log"))).toBe(false);
  });

  it("says the feed cannot be read when a read fails or a row does not read, never that it is quiet", async () => {
    feedAnswer = () => {
      throw new DbError("timeout");
    };
    await page();
    expect(screen.queryByText("Nothing has happened with money yet.")).toBeNull();
    expect(screen.queryByRole("list", { name: "Live feed lines" })).toBeNull();
    cleanup();

    feedAnswer = () => [{ ...FEED_ROWS[0], cents: "12.50" }];
    await page();
    expect(screen.queryByText("Nothing has happened with money yet.")).toBeNull();
    expect(screen.queryByText(/Fuel card load/)).toBeNull();
  });
});
