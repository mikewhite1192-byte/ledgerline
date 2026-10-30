// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_ANCHOR } from "@/components/app/anchors";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { nextWeekStart } from "@/lib/pay-rules/words";
import { INVOICES, SETTLEMENTS_VIEW } from "@/test/page-fixtures";
import Home from "./page";

// The home screen's ?rule=1 path, from the Pay rules page's button: the question box starts with
// the example change and the help under it, both dated the first week a change can start. Then
// Home's order (today and what needs your OK, the chat, payday, money), a card's "Ask about this",
// and a card that could not be read, Friday's pay run among them. Every read is faked and the clock
// is fixed; nothing reads the wall clock.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};

const mocks = vi.hoisted(() => ({
  withRequestTenant: vi.fn(),
  readNextWeekStart: vi.fn(),
  readRecentAgentTurns: vi.fn(),
  readNeedsYou: vi.fn(),
  readTodayIntake: vi.fn(),
  readMoneyFlow: vi.fn(),
  readSettlementsView: vi.fn(),
  readInvoiceList: vi.fn(),
  readCashHome: vi.fn(),
}));

vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));
vi.mock("@/lib/pay-rules/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-rules/read")>()),
  readNextWeekStart: mocks.readNextWeekStart,
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readRecentAgentTurns: mocks.readRecentAgentTurns,
}));
// The chat itself is a client component with its own tests; here only what the page hands it.
vi.mock("@/components/agent/turn-view", () => ({
  AgentChat: ({ initialDraft, initialHelp }: { initialDraft?: string; initialHelp?: string }) => (
    <div>
      <p data-testid="draft">{initialDraft ?? ""}</p>
      <p data-testid="help">{initialHelp ?? ""}</p>
    </div>
  ),
}));
vi.mock("./ai-proof-form", () => ({ AiProofForm: () => null }));
// Home's own reads have their own database tests; here only what the page does with what they return.
vi.mock("@/lib/home/needs-you", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/home/needs-you")>()),
  readNeedsYou: mocks.readNeedsYou,
}));
vi.mock("@/lib/home/today", () => ({ readTodayIntake: mocks.readTodayIntake }));
vi.mock("@/lib/home/money-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/home/money-flow")>()),
  readMoneyFlow: mocks.readMoneyFlow,
}));
vi.mock("@/lib/settlements/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlements/views")>()),
  readSettlementsView: mocks.readSettlementsView,
}));
vi.mock("@/lib/invoices/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/views")>()),
  readInvoiceList: mocks.readInvoiceList,
}));
vi.mock("@/lib/cash/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cash/view")>()),
  readCashHome: mocks.readCashHome,
}));

// The request's transaction: one carrier in New York, one member, and its record counts.
const q: Queryable = {
  async query<T>(sql: string): Promise<T[]> {
    if (sql.startsWith("SELECT name, timezone FROM tenants")) {
      return [{ name: "Blue Ridge", timezone: "America/New_York" }] as T[];
    }
    if (sql.startsWith("SELECT email, role FROM memberships")) return [{ email: SESSION.email, role: "staff" }] as T[];
    if (sql.includes("FROM drivers")) return [{ drivers: 1, loads: 2, periods: 3 }] as T[];
    throw new Error(`unexpected read: ${sql}`);
  },
  async execute() {
    throw new Error("the page writes nothing");
  },
};

const SWITCHES = ["rulesByTalkingEnabled", "agentEnabled", "agentFocusEnabled", "aiEnabled"] as const;
// The switches whose reads the fake transaction above does not answer (the needs-you rows of the
// pay run, advances, invoices and the chat loop's escalations, the sweep's line, Friday's cash
// card): off, so the page reads only what this test fakes.
const OFF = ["settlementsEnabled", "advancesEnabled", "invoicesEnabled", "sweepEnabled", "cashFridayEnabled"] as const;
const saved = Object.fromEntries([...SWITCHES, ...OFF].map((k) => [k, flags[k]]));
const WEEKS = [
  { start: "2026-10-26", end: "2026-11-01", inCents: 150_000, outCents: 120_000 },
  { start: "2026-11-02", end: "2026-11-08", inCents: 0, outCents: 98_765 },
];
const savedVerification = flags.verification;

beforeEach(() => {
  // Tuesday Nov 10, 2026, after the week of Nov 9 has begun.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
  for (const k of SWITCHES) flags[k] = true;
  for (const k of OFF) flags[k] = false;
  flags.verification = { ...savedVerification, enabled: false };
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => unknown) => fn(q, SESSION));
  mocks.readNextWeekStart.mockImplementation(async (_q: Queryable, now: Date) =>
    nextWeekStart(now, "America/New_York", 1),
  );
  mocks.readRecentAgentTurns.mockResolvedValue([]);
  mocks.readNeedsYou.mockResolvedValue([]);
  mocks.readTodayIntake.mockResolvedValue({ documents: 2, voiceNotes: 0, messages: 1 });
  mocks.readMoneyFlow.mockResolvedValue(WEEKS);
  mocks.readSettlementsView.mockResolvedValue(SETTLEMENTS_VIEW);
  mocks.readInvoiceList.mockResolvedValue(INVOICES);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const k of [...SWITCHES, ...OFF]) flags[k] = saved[k];
  flags.verification = savedVerification;
  vi.clearAllMocks();
});

describe("home, ?rule=1", () => {
  it("starts the box with the example and its help dated the next week start, past Nov 9", async () => {
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("draft").textContent).toBe("Starting Nov 16, owner-operator insurance goes to $12 a day");
    expect(screen.getByTestId("help").textContent).toBe(
      "Say the rule, the new amount and the date it starts. Example: 'From Nov 16, the net pay floor is $350 a week.'",
    );
  });

  it("starts the box empty while pay rule changes are off", async () => {
    flags.rulesByTalkingEnabled = false;
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("draft").textContent).toBe("");
    expect(screen.getByTestId("help").textContent).toBe("");
    expect(mocks.readNextWeekStart).not.toHaveBeenCalled();
  });

  it("shows no agent launcher with the panel switches on: its chat is inline", async () => {
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("button", { name: "Ask the agent" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
  });
});

// The pay run's and invoices' cards, on for these tests with their reads faked above.
const cardsOn = () => {
  flags.settlementsEnabled = true;
  flags.invoicesEnabled = true;
};
const region = (name: string) => screen.getByRole("region", { name });
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("home's order and cards", () => {
  it("opens on today and what needs your OK, then the chat, then payday, then money", async () => {
    cardsOn();
    render(await Home({ searchParams: Promise.resolve({}) }));
    const order = [
      screen.getByText(/^Good morning, Blue Ridge$/),
      region("Today"),
      region("Needs you"),
      screen.getByTestId("draft"),
      screen.getByRole("heading", { name: "This pay week" }),
      region("Paystubs"),
      screen.getByRole("heading", { name: "Money" }),
      region("Money in and out"),
      region("Owed to you"),
    ];
    for (let i = 1; i < order.length; i++) expect(before(order[i - 1], order[i])).toBe(true);
    // The chat stays inline, under its anchor, and no card adds a button a person could take for it.
    expect(document.getElementById(ASK_ANCHOR)?.contains(screen.getByTestId("draft"))).toBe(true);
    expect(screen.queryAllByRole("button", { name: /send|^Asking/i })).toHaveLength(0);
    expect(region("Today").textContent).toContain("2 documents, 0 voice notes and 1 driver message today.");
    expect(region("Paystubs").textContent).toContain(`Net pay on ${SETTLEMENTS_VIEW.rows.length} paystubs`);
    expect(region("Money in and out").textContent).toContain("Over the last 2 pay weeks.");
    expect(mocks.readTodayIntake).toHaveBeenCalledWith(expect.anything(), "2026-11-10");
    expect(mocks.readMoneyFlow).toHaveBeenCalledWith(expect.anything(), "2026-11-10");
  });

  it("links each money card's Ask about this to the chat, and drops it while the agent is off", async () => {
    cardsOn();
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(
      within(region("Paystubs")).getByRole("link", { name: "Ask about this: Paystubs" }).getAttribute("href"),
    ).toBe(`/?ask=payday#${ASK_ANCHOR}`);
    expect(within(region("Owed to you")).getByRole("link", { name: /^Ask about this/ }).getAttribute("href")).toBe(
      `/?ask=owed#${ASK_ANCHOR}`,
    );
    cleanup();
    flags.agentEnabled = false;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.queryAllByRole("link", { name: /^Ask about this/ })).toHaveLength(0);
  });

  it("starts the box with the card's question, and a document or pay rule ask wins over it", async () => {
    const draftFor = async (params: Record<string, string>) => {
      render(await Home({ searchParams: Promise.resolve(params) }));
      const draft = screen.getByTestId("draft").textContent;
      cleanup();
      return draft;
    };
    expect(await draftFor({ ask: "payday" })).toBe("Who has a problem on this week's paystub?");
    expect(await draftFor({ ask: "owed" })).toBe("Who owes us money past 60 days?");
    // The pay run's question is set when the page loads: whether there is cash to make it while Cash
    // Friday is on, else what it will cost.
    expect(["Can we make Friday's pay run?", "What will Friday's pay run cost?"]).toContain(
      await draftFor({ ask: "cash" }),
    );
    expect(await draftFor({ ask: "toString" })).toBe("");
    expect(await draftFor({ ask: "payday", rule: "1" })).toBe(
      "Starting Nov 16, owner-operator insurance goes to $12 a day",
    );
    const doc = "22222222-2222-4222-8222-222222222222";
    expect(await draftFor({ ask: "payday", document: doc })).toBe(`Check document ${doc}`);
  });

  it("shows a card that could not be read as unavailable and leaves the rest of the page alone", async () => {
    cardsOn();
    mocks.readTodayIntake.mockRejectedValue(new DbError("unavailable"));
    mocks.readMoneyFlow.mockRejectedValue(new DbError("unknown"));
    mocks.readInvoiceList.mockRejectedValue(new DbError("timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(await Home({ searchParams: Promise.resolve({}) }));
      expect(within(region("Today")).getByText("Could not read what came in today.")).toBeTruthy();
      expect(within(region("Money in and out")).getByRole("status").textContent).toBe("Could not read money in and out.");
      expect(within(region("Owed to you")).getByRole("status").textContent).toBe("Could not read what customers owe.");
      expect(region("Money in and out").querySelector("[data-money]")).toBeNull();
      expect(region("Paystubs").textContent).toContain("Net pay on");
      expect(screen.getByTestId("draft")).toBeTruthy();
      // Only the error's name reaches the log.
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          ["home card read failed:", "intake", "DbError"],
          ["home card read failed:", "money flow", "DbError"],
          ["home card read failed:", "owed", "DbError"],
        ]),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("shows Friday's pay run as unavailable when its check cannot be read, and leaves it out while Cash Friday is off", async () => {
    flags.cashFridayEnabled = true;
    mocks.readCashHome.mockRejectedValue(new DbError("timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(await Home({ searchParams: Promise.resolve({}) }));
      const card = region("Friday's pay run");
      expect(within(card).getByRole("status").textContent).toBe("Could not read the last check of Friday's pay run.");
      expect(card.textContent).not.toContain("Not checked yet");
      expect(within(card).getByRole("link", { name: "Open the Cash page" }).getAttribute("href")).toBe("/cash");
      expect(region("Today")).toBeTruthy();
      // Only the error's name reaches the log.
      expect(log.mock.calls).toContainEqual(["cash home read failed:", "DbError"]);
      cleanup();
      flags.cashFridayEnabled = false;
      render(await Home({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole("region", { name: "Friday's pay run" })).toBeNull();
      expect(mocks.readCashHome).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("lets any other failure go on to the framework, never as an empty card", async () => {
    mocks.readTodayIntake.mockRejectedValue(new Error("boom"));
    await expect(Home({ searchParams: Promise.resolve({}) })).rejects.toThrow("boom");
  });

  it("leaves out the cards whose pages are off", async () => {
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("region", { name: "Paystubs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Money" })).toBeNull();
    expect(mocks.readSettlementsView).not.toHaveBeenCalled();
    expect(mocks.readMoneyFlow).not.toHaveBeenCalled();
    expect(mocks.readInvoiceList).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "This pay week" })).toBeTruthy();
    const shortcuts = within(screen.getByRole("list", { name: "Shortcuts" })).getAllByRole("link");
    expect(shortcuts.map((l) => l.textContent)).not.toContain("Run payday");
  });
});
