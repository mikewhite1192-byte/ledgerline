// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOpening } from "@/components/agent/panel-context";
import type { Suggestion } from "@/components/app/prompt-chips";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { nextWeekStart } from "@/lib/pay-rules/words";
import { INVOICES, SETTLEMENTS_VIEW } from "@/test/page-fixtures";
import Home from "./page";

// The home screen's ?rule=1 path, from the Pay rules page's button: the agent card opens with the
// example change and the help under it, both dated the first week a change can start. Then the
// other ways Home opens the card (a card's "Ask about this", a document, a paystub, Start over),
// Home's order (today and what needs your OK, payday, money), and a card that could not be read,
// Friday's pay run among them. Every read is faked and the clock
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
  readPaystubAsk: vi.fn(),
  readFeed: vi.fn(),
  readTourFacts: vi.fn(),
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
vi.mock("@/lib/settlements/list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlements/list")>()),
  readPaystubAsk: mocks.readPaystubAsk,
}));
// The launcher and its card are client components with their own tests; here only what the page
// hands them: how the card opens and the questions it offers.
vi.mock("@/components/agent/agent-launcher", () => ({
  AgentLauncher: ({
    opening,
    suggestions,
    children,
  }: {
    opening?: AgentOpening;
    suggestions: Suggestion[];
    children: ReactNode;
  }) => (
    <>
      {children}
      <button type="button">Ask the agent</button>
      <p data-testid="opening">{opening ? "open" : "closed"}</p>
      <p data-testid="draft">{opening?.draft ?? ""}</p>
      <p data-testid="help">{opening?.help ?? ""}</p>
      <p data-testid="fresh">{opening?.fresh ? "fresh" : ""}</p>
      <p data-testid="suggestions">{suggestions.map((x) => x.id).join(" ")}</p>
    </>
  ),
}));
vi.mock("@/lib/feed/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feed/read")>()),
  readFeed: mocks.readFeed,
}));
vi.mock("@/lib/tour/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tour/facts")>()),
  readTourFacts: mocks.readTourFacts,
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
const member = { role: "staff" };
const q: Queryable = {
  async query<T>(sql: string): Promise<T[]> {
    if (sql.startsWith("SELECT name, timezone FROM tenants")) {
      return [{ name: "Blue Ridge", timezone: "America/New_York" }] as T[];
    }
    if (sql.startsWith("SELECT email, role FROM memberships")) return [{ email: SESSION.email, role: member.role }] as T[];
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
const savedFeed = flags.activityFeed.enabled;
const savedTour = flags.signInTour.enabled;

beforeEach(() => {
  // Tuesday Nov 10, 2026, after the week of Nov 9 has begun.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
  for (const k of SWITCHES) flags[k] = true;
  for (const k of OFF) flags[k] = false;
  flags.verification = { ...savedVerification, enabled: false };
  // The live feed card has its own test below, which turns it on.
  flags.activityFeed.enabled = false;
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
  mocks.readPaystubAsk.mockResolvedValue({ driverName: "Dana Reyes", periodEnd: "2026-11-06" });
  member.role = "staff";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const k of [...SWITCHES, ...OFF]) flags[k] = saved[k];
  flags.verification = savedVerification;
  flags.activityFeed.enabled = savedFeed;
  flags.signInTour.enabled = savedTour;
  vi.clearAllMocks();
});

describe("home, ?rule=1", () => {
  it("opens the card with the example and its help dated the next week start, past Nov 9", async () => {
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("draft").textContent).toBe("Starting Nov 16, owner-operator insurance goes to $12 a day");
    expect(screen.getByTestId("help").textContent).toBe(
      "Say the rule, the new amount and the date it starts. Example: 'From Nov 16, the net pay floor is $350 a week.'",
    );
  });

  it("leaves the card closed while pay rule changes are off", async () => {
    flags.rulesByTalkingEnabled = false;
    render(await Home({ searchParams: Promise.resolve({ rule: "1" }) }));
    expect(screen.getByTestId("opening").textContent).toBe("closed");
    expect(screen.getByTestId("draft").textContent).toBe("");
    expect(screen.getByTestId("help").textContent).toBe("");
    expect(mocks.readNextWeekStart).not.toHaveBeenCalled();
  });

  it("shows the agent launcher on Home, closed, with no question box of its own", async () => {
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("button", { name: "Ask the agent" })).toBeTruthy();
    expect(screen.getByTestId("opening").textContent).toBe("closed");
    expect(screen.queryByRole("textbox", { name: "Your question" })).toBeNull();
    expect(document.getElementById("ask")).toBeNull();
    // Home's questions: every page's, plus the pay rule change while it is on.
    expect(screen.getByTestId("suggestions").textContent?.split(" ")).toContain("change-pay-rule");
  });

  it("shows no launcher while the agent is off", async () => {
    flags.agentEnabled = false;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("button", { name: "Ask the agent" })).toBeNull();
  });

  it("opens the card on a paystub's question, first among the suggestions", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    render(await Home({ searchParams: Promise.resolve({ paystub: id }) }));
    expect(mocks.readPaystubAsk).toHaveBeenCalledWith(expect.anything(), id);
    expect(screen.getByTestId("draft").textContent).toBe(
      "Explain Dana Reyes's paystub for the week ending Nov 6, 2026.",
    );
    expect(screen.getByTestId("suggestions").textContent?.split(" ")[0]).toBe("explain-paystub");
  });

  it("opens the card on a new conversation for Start over, and a judge's Home reads no turns", async () => {
    member.role = "judge";
    render(await Home({ searchParams: Promise.resolve({ new: "1" }) }));
    expect(screen.getByTestId("opening").textContent).toBe("open");
    expect(screen.getByTestId("fresh").textContent).toBe("fresh");
    expect(screen.getByTestId("draft").textContent).toBe("");
    expect(mocks.readRecentAgentTurns).not.toHaveBeenCalled();
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
  it("opens on today and what needs your OK, then payday, then money", async () => {
    cardsOn();
    render(await Home({ searchParams: Promise.resolve({}) }));
    const order = [
      screen.getByText(/^Good morning, Blue Ridge$/),
      region("Today"),
      region("Needs you"),
      screen.getByRole("heading", { name: "This pay week" }),
      region("Paystubs"),
      screen.getByRole("heading", { name: "Money" }),
      region("Money in and out"),
      region("Owed to you"),
    ];
    for (let i = 1; i < order.length; i++) expect(before(order[i - 1], order[i])).toBe(true);
    // The chat lives in the agent card now, and no card adds a button a person could take for it.
    expect(screen.queryAllByRole("button", { name: /send|^Asking/i })).toHaveLength(0);
    expect(region("Today").textContent).toContain("2 documents, 0 voice notes and 1 driver message today.");
    expect(region("Paystubs").textContent).toContain(`Net pay on ${SETTLEMENTS_VIEW.rows.length} paystubs`);
    expect(region("Money in and out").textContent).toContain("Over the last 2 pay weeks.");
    expect(mocks.readTodayIntake).toHaveBeenCalledWith(expect.anything(), "2026-11-10");
    expect(mocks.readMoneyFlow).toHaveBeenCalledWith(expect.anything(), "2026-11-10");
  });

  it("links each money card's Ask about this to the card, and drops it while the agent is off", async () => {
    cardsOn();
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(
      within(region("Paystubs")).getByRole("link", { name: "Ask about this: Paystubs" }).getAttribute("href"),
    ).toBe("/?ask=payday");
    expect(within(region("Owed to you")).getByRole("link", { name: /^Ask about this/ }).getAttribute("href")).toBe(
      "/?ask=owed",
    );
    cleanup();
    flags.agentEnabled = false;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.queryAllByRole("link", { name: /^Ask about this/ })).toHaveLength(0);
  });

  it("opens the card on the card's question, and a document or pay rule ask wins over it", async () => {
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
      expect(log.mock.calls).toContainEqual(["home card read failed:", "cash home", "DbError"]);
      cleanup();
      flags.cashFridayEnabled = false;
      render(await Home({ searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole("region", { name: "Friday's pay run" })).toBeNull();
      expect(mocks.readCashHome).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("lets a non-database failure of Friday's pay run read go on to the framework, never as an unavailable card", async () => {
    flags.cashFridayEnabled = true;
    mocks.readCashHome.mockRejectedValue(new TypeError("boom"));
    await expect(Home({ searchParams: Promise.resolve({}) })).rejects.toThrow("boom");
  });

  it("lets any other failure go on to the framework, never as an empty card", async () => {
    mocks.readTodayIntake.mockRejectedValue(new Error("boom"));
    await expect(Home({ searchParams: Promise.resolve({}) })).rejects.toThrow("boom");
  });

  it("starts the cards and Needs you reads while the agent's turns are still being read", async () => {
    cardsOn();
    flags.cashFridayEnabled = true;
    mocks.readCashHome.mockResolvedValue(null);
    let release: (turns: never[]) => void = () => {};
    mocks.readRecentAgentTurns.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const page = Home({ searchParams: Promise.resolve({}) });
    // Read in turn, nothing after the turns read would start until it came back.
    await vi.waitFor(() => {
      expect(mocks.readNeedsYou).toHaveBeenCalled();
      expect(mocks.readCashHome).toHaveBeenCalled();
      expect(mocks.readTodayIntake).toHaveBeenCalled();
      expect(mocks.readSettlementsView).toHaveBeenCalled();
    });
    release([]);
    render(await page);
    expect(region("Today")).toBeTruthy();
    expect(region("Needs you")).toBeTruthy();
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
    expect(screen.queryByRole("region", { name: "Live feed" })).toBeNull();
    expect(mocks.readFeed).not.toHaveBeenCalled();
  });

  it("shows the live feed's newest lines in the carrier's zone while it is on, and says so when they cannot be read", async () => {
    flags.activityFeed.enabled = true;
    mocks.readFeed.mockResolvedValue({
      rows: [
        {
          key: "desk:0f0e0d0c-0b0a-4908-8706-050403020100",
          at: "2026-11-10T14:00:00.000000Z",
          event: "desk_claimed",
          actor: "desk",
          cents: null,
          direction: null,
          title: null,
          kind: "card_transaction",
          code: null,
          reason: null,
          count: null,
          limitCents: null,
          dayLimitCents: null,
          until: null,
          channel: null,
          system: null,
          once: false,
          record: null,
        },
      ],
      next: null,
    });
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(mocks.readFeed).toHaveBeenCalledWith(expect.anything(), { limit: 3 });
    const feed = region("Live feed");
    expect(within(feed).getByText("Desk picked up a card transaction")).toBeTruthy();
    expect(within(feed).getByText("Nov 10, 2026, 9:00 AM EST")).toBeTruthy();
    expect(within(feed).getByRole("link", { name: "Open the live feed" }).getAttribute("href")).toBe("/activity");
    cleanup();

    mocks.readFeed.mockRejectedValue(new DbError("timeout"));
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(within(region("Live feed")).getByText("Could not read the feed. Nothing changed.")).toBeTruthy();
    expect(region("Today")).toBeTruthy();
  });
});

// The walkthrough's own reads are faked here; their words have their own tests (src/lib/tour).
const TOUR_FACTS = {
  digest: { ok: true, value: "Good morning. Nothing is late this week." },
  desk: { ok: true, value: { checkedAt: "2026-11-10T14:00:00.000Z", doneToday: 2 } },
  autopilot: null,
  board: null,
};
const walkthrough = () => screen.queryByRole("region", { name: "Walkthrough" });
const shortcutLabels = () =>
  within(screen.getByRole("list", { name: "Shortcuts" }))
    .queryAllByRole("link")
    .map((l) => l.textContent);

describe("home, the sign-in walkthrough", () => {
  it("opens on top of Home after a sign-in (?welcome=1) while its switch is on", async () => {
    flags.signInTour.enabled = true;
    mocks.readTourFacts.mockResolvedValue(TOUR_FACTS);
    render(await Home({ searchParams: Promise.resolve({ welcome: "1" }) }));
    const panel = walkthrough();
    expect(panel).toBeTruthy();
    expect(within(panel!).getByRole("heading").textContent).toBe("Your AI accountant is already working");
    expect(panel!.textContent).toContain("Good morning. Nothing is late this week.");
    expect(panel!.textContent).toContain("The desk last checked in Nov 10, 2026, 9:00 AM EST and finished 2 things today.");
    expect(before(panel!, screen.getByText(/^Good morning, Blue Ridge$/))).toBe(true);
    expect(mocks.readTourFacts).toHaveBeenCalledWith(
      expect.objectContaining({ today: "2026-11-10", timezone: "America/New_York" }),
    );
    // The rest of Home is all there under it, the agent's button among it.
    expect(region("Today")).toBeTruthy();
    expect(region("Needs you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask the agent" })).toBeTruthy();
    const show = within(screen.getByRole("list", { name: "Shortcuts" })).getByRole("link", { name: "Show me around" });
    expect(show.getAttribute("href")).toBe("/?welcome=1");
  });

  it("stays closed on a plain visit to Home, with the shortcut to open it", async () => {
    flags.signInTour.enabled = true;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(walkthrough()).toBeNull();
    expect(mocks.readTourFacts).not.toHaveBeenCalled();
    expect(shortcutLabels()).toContain("Show me around");
  });

  it("shows nothing and reads nothing while its switch is off, even with ?welcome=1", async () => {
    flags.signInTour.enabled = false;
    render(await Home({ searchParams: Promise.resolve({ welcome: "1" }) }));
    expect(walkthrough()).toBeNull();
    expect(mocks.readTourFacts).not.toHaveBeenCalled();
    expect(shortcutLabels()).not.toContain("Show me around");
    expect(region("Today")).toBeTruthy();
  });

  it("says which figure it could not read and keeps the rest of the panel and of Home", async () => {
    flags.signInTour.enabled = true;
    mocks.readTourFacts.mockResolvedValue({ ...TOUR_FACTS, digest: { ok: false }, desk: { ok: false } });
    mocks.readNeedsYou.mockRejectedValue(new DbError("timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(await Home({ searchParams: Promise.resolve({ welcome: "1" }) }));
      const panel = walkthrough()!;
      expect(within(panel).getAllByRole("status").map((s) => s.textContent)).toEqual([
        "Could not read the agent's latest morning line.",
        "Could not read when the desk last checked in.",
      ]);
      expect(region("Today")).toBeTruthy();
    } finally {
      log.mockRestore();
    }
  });
});

// The simple Home (flags.simpleShape): three blocks from the same reads. The describes above run
// with the switch off, as it ships.
const FEED_ROW = {
  key: "desk:0f0e0d0c-0b0a-4908-8706-050403020100",
  at: "2026-11-10T14:10:00.000000Z",
  event: "desk_done",
  actor: "desk",
  cents: null,
  direction: null,
  title: null,
  kind: "customer_payment",
  code: null,
  reason: null,
  count: null,
  limitCents: null,
  dayLimitCents: null,
  until: null,
  channel: null,
  system: null,
  once: false,
  record: null,
};
const NEEDS_ROWS = [
  {
    key: "past_due",
    count: 4,
    atLeast: false,
    what: "invoices past due",
    amounts: [{ cents: 610_000, label: "past due" }],
    href: "/invoices?tab=invoices",
    linkLabel: "Open invoices",
  },
  {
    key: "paystubs",
    count: 3,
    atLeast: false,
    what: "paystubs waiting for approval",
    amounts: [{ cents: 582_000, label: "to pay drivers" }],
    href: "/settlements",
    linkLabel: "Open settlements",
  },
  {
    key: "advances",
    count: 1,
    atLeast: false,
    what: "advance request waiting for a decision",
    amounts: [{ cents: 30_000, label: "requested" }],
    href: "/advances?status=requested",
    linkLabel: "Open advances",
  },
  {
    key: "invoice_cards",
    count: 2,
    atLeast: false,
    what: "invoice cards waiting for approval",
    amounts: [{ cents: 14_600, label: "to bill" }],
    href: "/invoices?tab=to-invoice",
    linkLabel: "Open invoices to send",
  },
];
const savedSimple = flags.simpleShape.enabled;
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("home, the simple shape", () => {
  beforeEach(() => {
    flags.simpleShape.enabled = true;
    flags.activityFeed.enabled = true;
    mocks.readFeed.mockResolvedValue({ rows: [FEED_ROW], next: null });
  });
  afterEach(() => {
    flags.simpleShape.enabled = savedSimple;
  });

  it("shows three blocks under the greeting, and reads none of the full Home's cards", async () => {
    flags.cashFridayEnabled = true;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/^Good morning, Blue Ridge$/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Shortcuts" })).toBeNull();
    expect(headings()).toEqual(["What I did today", "Needs you", "Ask me anything"]);
    const did = region("What I did today");
    expect(within(did).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Read 2 documents and 1 message from drivers.",
      "Checked a customer payment against its invoice.9:10 AM",
    ]);
    expect(within(did).getByRole("link", { name: "See everything" }).getAttribute("href")).toBe("/activity");
    expect(mocks.readFeed).toHaveBeenCalledWith(expect.anything(), { limit: 12 });
    expect(screen.queryByRole("heading", { name: "This pay week" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Live feed" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Today" })).toBeNull();
    expect(mocks.readCashHome).not.toHaveBeenCalled();
    expect(mocks.readSettlementsView).not.toHaveBeenCalled();
    expect(mocks.readMoneyFlow).not.toHaveBeenCalled();
    expect(mocks.readInvoiceList).not.toHaveBeenCalled();
    // The ask box is on the page, so the top bar leaves its own out; the agent's button stays.
    expect(screen.queryByText("Search or ask anything")).toBeNull();
    const ask = region("Ask me anything");
    // The first three of Home's questions; the launcher is faked here, so each is a link to Home's ask.
    expect(within(within(ask).getByRole("list", { name: "Questions to ask" })).getAllByRole("link").map((b) => b.textContent)).toEqual([
      "Who has a problem on this week's paystub?",
      "Who owes us money past 60 days?",
      "Can we make Friday's pay run?",
    ]);
    expect(screen.getByRole("button", { name: "Ask the agent" })).toBeTruthy();
    expect(document.getElementById("ask")).toBeNull();
    // No model cost, model name or model time on an everyday screen.
    expect(document.body.textContent).not.toMatch(/cents|Muse|model time/i);
  });

  it("cuts Needs you to the three that matter most, with one line for the rest, and the bell counts all", async () => {
    mocks.readNeedsYou.mockResolvedValue(NEEDS_ROWS);
    render(await Home({ searchParams: Promise.resolve({}) }));
    const needs = region("Needs you");
    expect(within(needs).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "3 paystubs to approve$5,820.00Review",
      "1 advance request$300.00Review",
      "2 invoices to approve$146.00Review",
    ]);
    expect(within(needs).getByRole("link", { name: "and 4 more on Billing" }).getAttribute("href")).toBe("/invoices?tab=invoices");
    expect(screen.getByRole("link", { name: "Needs you, 4 waiting" })).toBeTruthy();
  });

  it("says when nothing finished and nothing needs you, and when neither could be read", async () => {
    mocks.readTodayIntake.mockResolvedValue({ documents: 0, voiceNotes: 0, messages: 0 });
    mocks.readFeed.mockResolvedValue({ rows: [], next: null });
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(within(region("What I did today")).getByText(/^Nothing finished yet today\./)).toBeTruthy();
    expect(within(region("Needs you")).getByText("Nothing needs you right now.")).toBeTruthy();
    cleanup();

    mocks.readTodayIntake.mockRejectedValue(new DbError("timeout"));
    mocks.readFeed.mockRejectedValue(new DbError("timeout"));
    mocks.readNeedsYou.mockRejectedValue(new DbError("timeout"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(await Home({ searchParams: Promise.resolve({}) }));
      expect(within(region("What I did today")).getByRole("status").textContent).toBe("Could not read today's work. Nothing changed.");
      expect(within(region("Needs you")).getByRole("status").textContent).toBe(
        "Could not check everything that is waiting right now. Reload the page to try again.",
      );
      expect(within(region("Needs you")).queryByText("Nothing needs you right now.")).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("leaves the ask block out while the agent is off, and keeps the top bar's box away", async () => {
    flags.agentEnabled = false;
    render(await Home({ searchParams: Promise.resolve({}) }));
    expect(headings()).toEqual(["What I did today", "Needs you"]);
    expect(screen.queryByRole("button", { name: "Ask the agent" })).toBeNull();
  });

  it("opens a three step walkthrough after a sign-in, one step per block", async () => {
    flags.signInTour.enabled = true;
    mocks.readTourFacts.mockResolvedValue(TOUR_FACTS);
    render(await Home({ searchParams: Promise.resolve({ welcome: "1" }) }));
    const panel = walkthrough()!;
    expect(panel.textContent).toContain("step 1 of 3");
    expect(panel.textContent).toContain("Last checked the books at 9:00 AM and finished 2 things today.");
    expect(panel.textContent).not.toContain("Good morning. Nothing is late this week.");
    expect(panel.textContent).toContain("Written from today's numbers.");
    expect(panel.textContent).not.toMatch(/Muse|model/i);
    within(panel).getByRole("button", { name: "Skip" }).click();
  });
});
