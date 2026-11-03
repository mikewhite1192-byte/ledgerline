// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelContext } from "@/components/agent/panel-context";
import { TRUST_LINE } from "@/components/agent/words";
import { NEEDS_YOU_UNREAD } from "@/components/app/needs-you";
import type { DoneLine } from "@/lib/feed/words";
import type { Payday } from "@/lib/home/cards";
import type { NeedsYouRow } from "@/lib/home/needs-you";
import type { SweepRunView } from "@/lib/sweep/view";
import { Greeting, greetingFor } from "./greeting";
import { CashFlowCard, IN_LABEL, OUT_LABEL, OwedCard } from "./money-cards";
import { PaydayCard } from "./payday-card";
import { AskAnything, DID_TODAY_EMPTY, DID_TODAY_UNREAD, DidToday, NEEDS_YOU_NONE, NeedsYouShort } from "./simple-home";
import { TodayCard } from "./today-card";

// Home's own cards, each in its normal, empty and unavailable state. Every input is fixed; nothing
// reads the clock. Dates show as words, never as stored digits.

afterEach(cleanup);

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const ALL_SHOWN = { documents: true, voiceNotes: true, messages: true };

const RUN: SweepRunView = {
  id: "8f1d2c3b-0000-4000-8000-000000000001",
  periodId: "p",
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  trigger: "button",
  status: "done",
  phase: "done",
  capCents: 200,
  spentCents: 42,
  counts: { found: 7, fixes_drafted: 5 },
  truncatedReason: null,
  failureCategory: null,
  conversationId: null,
  // 9 AM on Nov 2 in Chicago.
  startedAt: "2026-11-02T15:00:00.000Z",
  finishedAt: "2026-11-02T15:03:00.000Z",
  approved: 2,
  checklist: [],
} as unknown as SweepRunView;

const ROW: NeedsYouRow = {
  key: "paystubs",
  count: 3,
  atLeast: false,
  what: "paystubs waiting for approval",
  amounts: [{ cents: 150_000, label: "to pay drivers" }],
  href: "/settlements",
  linkLabel: "Open settlements",
};

const today = (over: Partial<Parameters<typeof TodayCard>[0]> = {}) =>
  render(
    <TodayCard
      intake={{ ok: true, value: { documents: 3, voiceNotes: 1, messages: 2 } }}
      shown={ALL_SHOWN}
      sweep={{ ok: true, value: RUN }}
      needs={{ rows: [ROW, { ...ROW, key: "advances", count: 2 }], unread: false }}
      today="2026-11-02"
      timezone="America/Chicago"
      {...over}
    />,
  );

describe("Greeting", () => {
  it("greets by the carrier's hour", () => {
    expect([0, 11, 12, 16, 17, 23].map(greetingFor)).toEqual([
      "Good morning",
      "Good morning",
      "Good afternoon",
      "Good afternoon",
      "Good evening",
      "Good evening",
    ]);
  });

  it("names the carrier and the day in words, with the first shortcut filled", () => {
    render(
      <Greeting
        name="Blue Ridge"
        today="2026-11-02"
        hour={9}
        shortcuts={[
          { label: "Run payday", href: "/sweep" },
          { label: "Upload document", href: "/documents" },
        ]}
      />,
    );
    expect(screen.getByText("Good morning, Blue Ridge")).toBeTruthy();
    expect(screen.getByText("Monday, Nov 2, 2026")).toBeTruthy();
    const links = within(screen.getByRole("list", { name: "Shortcuts" })).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Run payday", "/sweep"],
      ["Upload document", "/documents"],
    ]);
    expect(links[0].className).toContain("bg-primary");
    expect(links[1].className).not.toContain("bg-primary");
  });

  it("shows no shortcut list when every page is off", () => {
    render(<Greeting name="Blue Ridge" today="2026-11-02" hour={20} shortcuts={[]} />);
    expect(screen.getByText("Good evening, Blue Ridge")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Shortcuts" })).toBeNull();
  });
});

describe("TodayCard", () => {
  it("says what came in, what the agent did today and how much waits for an OK", () => {
    today();
    const card = screen.getByRole("region", { name: "Today" });
    expect(card.textContent).toContain("3 documents, 1 voice note and 2 driver messages today.");
    expect(card.textContent).toContain("Swept the books today: found 7 problems, drafted 5 fixes, 2 approved.");
    expect(within(card).getByRole("link", { name: "Open the sweep" }).getAttribute("href")).toBe(`/sweep/${RUN.id}`);
    expect(card.textContent).toContain("5 items waiting for your OK.");
    expect(within(card).getByRole("link", { name: "See what needs you" }).getAttribute("href")).toBe("#needs-you");
    expect(card.textContent).not.toMatch(ISO_DATE);
    // No amounts on this card: the figures to approve sit in Needs you.
    expect(card.querySelector("[data-money]")).toBeNull();
  });

  it("dates an older sweep in words and lists only the kinds that are on", () => {
    today({
      shown: { documents: true, voiceNotes: false, messages: false },
      sweep: { ok: true, value: { ...RUN, counts: { found: 1, fixes_drafted: 1 }, approved: 0 } },
      today: "2026-11-04",
    });
    const card = screen.getByRole("region", { name: "Today" });
    expect(card.textContent).toContain("3 documents today.");
    expect(card.textContent).not.toContain("voice");
    expect(card.textContent).toContain("Last sweep, Nov 2, 2026: found 1 problem, drafted 1 fix, 0 approved.");
    expect(card.textContent).not.toMatch(ISO_DATE);
  });

  it("reads a quiet day as nothing yet, and says so when no sweep ran or nothing waits", () => {
    today({
      intake: { ok: true, value: { documents: 0, voiceNotes: 0, messages: 0 } },
      sweep: { ok: true, value: null },
      needs: { rows: [], unread: false },
    });
    const card = screen.getByRole("region", { name: "Today" });
    expect(card.textContent).toContain("Nothing yet today.");
    expect(card.textContent).toContain("No sweep of the books has run yet.");
    expect(card.textContent).toContain("Nothing needs your OK right now.");
  });

  it("says a running or stopped sweep in plain words", () => {
    today({ sweep: { ok: true, value: { ...RUN, status: "running" } } });
    expect(screen.getByRole("region", { name: "Today" }).textContent).toContain("A sweep of the books is running now.");
    cleanup();
    today({ sweep: { ok: true, value: { ...RUN, status: "failed" } } });
    expect(screen.getByRole("region", { name: "Today" }).textContent).toContain(
      "The last sweep stopped before it finished.",
    );
  });

  it("shows each failed read as unavailable, never as zero", () => {
    today({ intake: { ok: false }, sweep: { ok: false }, needs: { rows: [ROW], unread: true } });
    const card = screen.getByRole("region", { name: "Today" });
    const status = within(card).getAllByRole("status").map((s) => s.textContent);
    expect(status).toEqual([
      "Could not read what came in today.",
      "Could not read the last sweep.",
      "Could not check everything that is waiting on you.",
    ]);
    expect(card.textContent).not.toMatch(/\b0 /);
  });

  it("leaves out the lines whose pages are off", () => {
    today({ intake: null, sweep: null });
    const card = screen.getByRole("region", { name: "Today" });
    expect(card.textContent).not.toContain("Came in");
    expect(card.textContent).not.toContain("Did");
    expect(card.textContent).toContain("Needs your OK");
  });

  it("says 'or more' when a count was cut off", () => {
    today({ needs: { rows: [{ ...ROW, atLeast: true }], unread: false } });
    expect(screen.getByRole("region", { name: "Today" }).textContent).toContain("3 items or more waiting for your OK.");
  });
});

const PAYDAY: Payday = {
  period: { id: "p", start: "2026-11-02", end: "2026-11-08", status: "open" },
  paystubs: 4,
  waiting: 2,
  approved: 1,
  paid: 0,
  held: 1,
  problems: 1,
  netCents: 456_789,
};

describe("PaydayCard", () => {
  it("shows the week in words, its net pay and where the paystubs stand", () => {
    render(<PaydayCard payday={{ ok: true, value: PAYDAY }} askHref="/?ask=payday" />);
    const card = screen.getByRole("region", { name: "Paystubs" });
    expect(card.textContent).toContain("Nov 2 to Nov 8, 2026");
    expect(card.querySelector("[data-money]")?.textContent).toBe("$4,567.89");
    expect(card.textContent).toContain("Net pay on 4 paystubs");
    const stand = within(card).getByRole("list", { name: "Where the paystubs stand" });
    expect(within(stand).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2 waiting for your OK",
      "1 approved",
      "0 paid",
      "1 with a problem",
      "1 held back",
    ]);
    expect(within(card).getByRole("link", { name: "Open settlements" }).getAttribute("href")).toBe("/settlements");
    expect(within(card).getByRole("link", { name: "Ask about this: Paystubs" }).getAttribute("href")).toBe(
      "/?ask=payday",
    );
    expect(card.textContent).not.toMatch(ISO_DATE);
  });

  it("leaves the problem and held lines out when there are none, and Ask out while the agent is off", () => {
    render(<PaydayCard payday={{ ok: true, value: { ...PAYDAY, held: 0, problems: 0 } }} />);
    const card = screen.getByRole("region", { name: "Paystubs" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).queryByRole("link", { name: /^Ask about this/ })).toBeNull();
  });

  it("says when no week is open or no paystub is built yet", () => {
    render(<PaydayCard payday={{ ok: true, value: { ...PAYDAY, period: null, paystubs: 0 } }} />);
    expect(screen.getByRole("region", { name: "Paystubs" }).textContent).toContain("No pay week is open yet.");
    cleanup();
    render(<PaydayCard payday={{ ok: true, value: { ...PAYDAY, paystubs: 0, netCents: 0 } }} />);
    const card = screen.getByRole("region", { name: "Paystubs" });
    expect(card.textContent).toContain("No paystubs built for Nov 2 to Nov 8, 2026 yet.");
    expect(card.querySelector("[data-money]")).toBeNull();
  });

  it("shows a failed read as unavailable, never as zero", () => {
    render(<PaydayCard payday={{ ok: false }} />);
    const card = screen.getByRole("region", { name: "Paystubs" });
    expect(within(card).getByRole("status").textContent).toBe("Could not read this pay week's paystubs.");
    expect(card.querySelector("[data-money]")).toBeNull();
  });
});

const WEEKS = [
  { start: "2026-10-19", end: "2026-10-25", inCents: 150_000, outCents: 123_456 },
  { start: "2026-10-26", end: "2026-11-01", inCents: 7_000, outCents: 0 },
];

describe("CashFlowCard", () => {
  it("totals money in and out, draws a bar per amount and lists each week in words", () => {
    render(<CashFlowCard flow={{ ok: true, value: WEEKS }} askHref="/?ask=cash" />);
    const card = screen.getByRole("region", { name: "Money in and out" });
    expect(card.textContent).toContain(IN_LABEL);
    expect(card.textContent).toContain(OUT_LABEL);
    expect(card.textContent).toContain("Over the last 2 pay weeks.");
    const amounts = [...card.querySelectorAll("[data-money]")].map((m) => m.textContent);
    expect(amounts).toEqual(["$1,570.00", "$1,234.56", "$1,500.00", "$1,234.56", "$70.00", "$0.00"]);
    const weeks = within(card).getByRole("list", { name: "Money in and out by pay week" });
    expect(within(weeks).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Oct 19 to Oct 25, 2026In $1,500.00, out $1,234.56",
      "Oct 26 to Nov 1, 2026In $70.00, out $0.00",
    ]);
    // The picture is for the eye; the list above it carries the figures. A zero draws no bar.
    const svg = card.querySelector("svg[aria-hidden]");
    expect(svg?.querySelectorAll("path")).toHaveLength(3);
    expect(card.textContent).not.toMatch(ISO_DATE);
    expect(within(card).getByRole("link", { name: "Ask about this: Money in and out" })).toBeTruthy();
  });

  it("says when there are no pay weeks yet", () => {
    render(<CashFlowCard flow={{ ok: true, value: [] }} />);
    const card = screen.getByRole("region", { name: "Money in and out" });
    expect(card.textContent).toContain("No pay weeks yet.");
    expect(card.querySelector("svg[aria-hidden]")).toBeNull();
  });

  it("shows a failed read as unavailable, never as zero", () => {
    render(<CashFlowCard flow={{ ok: false }} />);
    const card = screen.getByRole("region", { name: "Money in and out" });
    expect(within(card).getByRole("status").textContent).toBe("Could not read money in and out.");
    expect(card.querySelector("[data-money]")).toBeNull();
  });
});

describe("OwedCard", () => {
  it("shows what customers owe and how much is past due", () => {
    render(
      <OwedCard owed={{ ok: true, value: { invoices: 3, owedCents: 60_000, late: 2, lateCents: 50_000 } }} askHref="/?ask=owed" />,
    );
    const card = screen.getByRole("region", { name: "Owed to you" });
    expect([...card.querySelectorAll("[data-money]")].map((m) => m.textContent)).toEqual(["$600.00", "$500.00"]);
    expect(card.textContent).toContain("On 3 open invoices");
    expect(card.textContent).toContain("2 past due, $500.00");
    expect(within(card).getByRole("link", { name: "Open invoices" }).getAttribute("href")).toBe("/invoices?tab=invoices");
  });

  it("says none is past due when every balance is current", () => {
    render(<OwedCard owed={{ ok: true, value: { invoices: 1, owedCents: 10_000, late: 0, lateCents: 0 } }} />);
    const card = screen.getByRole("region", { name: "Owed to you" });
    expect(card.textContent).toContain("On 1 open invoice");
    expect(card.textContent).toContain("None past due");
  });

  it("says when nobody owes anything", () => {
    render(<OwedCard owed={{ ok: true, value: { invoices: 0, owedCents: 0, late: 0, lateCents: 0 } }} />);
    expect(screen.getByRole("region", { name: "Owed to you" }).textContent).toContain(
      "No customer owes you money right now.",
    );
  });

  it("shows a failed read as unavailable, never as zero", () => {
    render(<OwedCard owed={{ ok: false }} />);
    const card = screen.getByRole("region", { name: "Owed to you" });
    expect(within(card).getByRole("status").textContent).toBe("Could not read what customers owe.");
    expect(card.querySelector("[data-money]")).toBeNull();
  });
});

// The simple Home's three blocks (flags.simpleShape).

const DONE: DoneLine[] = [
  { key: "desk:a", at: "2026-11-02T15:40:00.000000Z", time: "9:40 AM", words: "Checked a customer payment against its invoice.", href: null },
  {
    key: "money:b:settled",
    at: "2026-11-02T16:10:00.000000Z",
    time: "10:10 AM",
    words: "Paid an advance, $200.00.",
    href: "/records/advances/8f1d2c3b-0000-4000-8000-000000000002",
  },
];

const SHOWN = { ...ALL_SHOWN, notesPage: true };

const didToday = (over: Partial<Parameters<typeof DidToday>[0]> = {}) =>
  render(
    <DidToday
      sweep={{ ok: true, value: RUN }}
      intake={{ ok: true, value: { documents: 2, voiceNotes: 0, messages: 1 } }}
      shown={SHOWN}
      done={{ ok: true, value: DONE }}
      today="2026-11-02"
      timezone="America/Chicago"
      {...over}
    />,
  );

const lines = () =>
  within(screen.getByRole("list", { name: "Done today" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("DidToday", () => {
  it("lists the pay check, what came in and today's finished work, each with its time and page", () => {
    didToday();
    expect(screen.getByRole("heading", { name: "What I did today" })).toBeTruthy();
    expect(lines()).toEqual([
      "Checked every driver's pay for the week of Oct 26 to Nov 1. Found 7 mistakes and drafted fixes for 5.9:00 AM",
      "Read 2 documents and 1 message from drivers.",
      "Checked a customer payment against its invoice.9:40 AM",
      "Paid an advance, $200.00.10:10 AM",
    ]);
    expect(screen.getByRole("link", { name: /Checked every driver's pay/ }).getAttribute("href")).toBe(`/sweep/${RUN.id}`);
    expect(screen.getByRole("link", { name: /Read 2 documents/ }).getAttribute("href")).toBe("/documents");
    expect(screen.getByRole("link", { name: /Paid an advance/ }).getAttribute("href")).toBe(DONE[1].href);
    expect(screen.queryByRole("link", { name: /customer payment/ })).toBeNull();
    expect(screen.getByRole("link", { name: "See everything" }).getAttribute("href")).toBe("/activity");
    expect(document.body.textContent).not.toMatch(ISO_DATE);
  });

  it("leaves out a pay check from another day, kinds that are off and kinds with nothing", () => {
    didToday({
      today: "2026-11-03",
      intake: { ok: true, value: { documents: 0, voiceNotes: 1, messages: 4 } },
      shown: { ...SHOWN, documents: false, voiceNotes: false },
    });
    expect(lines()[0]).toBe("Read 4 messages from drivers.");
    expect(screen.getByRole("link", { name: /Read 4 messages/ }).getAttribute("href")).toBe("/driver-notes");
    expect(document.body.textContent).not.toContain("Checked every driver's pay");
  });

  it("says nothing finished yet on a quiet day, without the feed link", () => {
    didToday({ sweep: { ok: true, value: null }, intake: { ok: true, value: { documents: 0, voiceNotes: 0, messages: 0 } }, done: { ok: true, value: [] } });
    expect(screen.getByText(DID_TODAY_EMPTY)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "See everything" })).toBeNull();
  });

  it("drops only a failed read's lines, and says so when every read failed, never nothing", () => {
    didToday({ done: { ok: false } });
    expect(lines()).toHaveLength(2);
    cleanup();
    didToday({ sweep: { ok: false }, intake: { ok: false }, done: { ok: false } });
    expect(screen.getByRole("status").textContent).toBe(DID_TODAY_UNREAD);
    expect(screen.queryByText(DID_TODAY_EMPTY)).toBeNull();
  });

  it("words a pay check still running or one that stopped", () => {
    didToday({ sweep: { ok: true, value: { ...RUN, status: "running" } }, done: null, intake: null });
    expect(lines()).toEqual(["Checking every driver's pay for the week of Oct 26 to Nov 1 now.9:00 AM"]);
    // The feed is off: no link to it.
    expect(screen.queryByRole("link", { name: "See everything" })).toBeNull();
    cleanup();
    didToday({ sweep: { ok: true, value: { ...RUN, status: "failed" } }, done: null, intake: null });
    expect(lines()).toEqual(["The pay check stopped before it finished.9:00 AM"]);
  });
});

const NEEDS: NeedsYouRow[] = [
  { ...ROW, key: "escalated", count: 1, amounts: [], href: "#ask", linkLabel: "Open the chat" },
  { ...ROW, key: "past_due", count: 4, amounts: [{ cents: 610_000, label: "past due" }], href: "/invoices?tab=invoices" },
  { ...ROW, key: "advances", count: 1, amounts: [{ cents: 30_000, label: "requested" }], href: "/advances?status=requested" },
  ROW,
  { ...ROW, key: "cards", count: 2, amounts: [{ cents: 14_600, label: "in fixes" }], href: "#card-1" },
];

const rowsOf = () =>
  within(screen.getByRole("list", { name: "Waiting on you" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("NeedsYouShort", () => {
  it("shows the three that matter most, each one tap with Review, and what was cut", () => {
    render(<NeedsYouShort view={{ rows: NEEDS, unread: false }} />);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(rowsOf()).toEqual([
      "3 paystubs to approve$1,500.00Review",
      "1 advance request$300.00Review",
      "2 cards in your chat to approve$146.00Review",
    ]);
    const links = within(screen.getByRole("list", { name: "Waiting on you" })).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/settlements", "/advances?status=requested", "#card-1"]);
    expect(document.body.textContent).not.toMatch(/Approve\b/);
    // The cut rows: past due on Billing, the escalated ask in the chat, each counted where it is.
    const more = screen.getByRole("link", { name: "and 5 more: 4 on Billing, 1 in your chat" });
    expect(more.getAttribute("href")).toBe("/invoices?tab=invoices");
    // Its amounts never hide under the eye.
    expect(screen.getByRole("list", { name: "Waiting on you" }).getAttribute("data-amounts")).toBe("shown");
  });

  it("says at least for a cut place whose count is a floor, and one place without the split", () => {
    render(<NeedsYouShort view={{ rows: [ROW, NEEDS[2], NEEDS[4], { ...NEEDS[1], atLeast: true }, NEEDS[0]], unread: false }} />);
    expect(screen.getByRole("link", { name: "and at least 5 more: at least 4 on Billing, 1 in your chat" })).toBeTruthy();
    cleanup();
    render(<NeedsYouShort view={{ rows: [ROW, NEEDS[2], NEEDS[4], NEEDS[1]], unread: false }} />);
    expect(screen.getByRole("link", { name: "and 4 more on Billing" })).toBeTruthy();
  });

  it("shows each amount a row carries, saying which is which when there are two", () => {
    const cards: NeedsYouRow = {
      ...ROW,
      key: "cards",
      count: 2,
      amounts: [
        { cents: 30_000, label: "to pay out" },
        { cents: 90_000, label: "coming in" },
      ],
      href: "#card-1",
    };
    render(<NeedsYouShort view={{ rows: [cards], unread: false }} />);
    expect(rowsOf()).toEqual(["2 cards in your chat to approve$300.00 to pay out$900.00 coming inReview"]);
  });

  it("shows every row with no more line when three or fewer wait, and says or more for a cut count", () => {
    render(<NeedsYouShort view={{ rows: [{ ...ROW, atLeast: true }, NEEDS[0]], unread: false }} />);
    expect(rowsOf()).toEqual(["3 or more paystubs to approveAt least $1,500.00Review", "1 request from your chat needs youReview"]);
    expect(screen.queryByText(/more on/)).toBeNull();
  });

  it("says nothing needs you, or that it could not check, never both", () => {
    render(<NeedsYouShort view={{ rows: [], unread: false }} />);
    expect(screen.getByText(NEEDS_YOU_NONE)).toBeTruthy();
    cleanup();
    render(<NeedsYouShort view={{ rows: [], unread: true }} />);
    expect(screen.getByRole("status").textContent).toBe(NEEDS_YOU_UNREAD);
    expect(screen.queryByText(NEEDS_YOU_NONE)).toBeNull();
  });
});

const SUGGESTIONS = [
  { id: "a", label: "Who has a problem on this week's paystub?", reason: "r" },
  { id: "b", label: "Who owes us money past 60 days?", reason: "r" },
  { id: "c", label: "Pay rule change", reason: "r", fill: "Starting Nov 16, pay Dana 60 cents a mile.", help: "Say the rule." },
  { id: "d", label: "Who is over their advance limit?", reason: "r" },
];

describe("AskAnything", () => {
  it("opens the card from the box, puts a chip's question in it, and says nothing moves without you", () => {
    const open = vi.fn();
    render(
      <PanelContext.Provider value={{ open }}>
        <AskAnything suggestions={SUGGESTIONS} />
      </PanelContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Ask me anything" })).toBeTruthy();
    const chips = within(screen.getByRole("list", { name: "Questions to ask" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(SUGGESTIONS.slice(0, 3).map((s) => s.label));
    chips[0].click();
    expect(open).toHaveBeenLastCalledWith({ draft: SUGGESTIONS[0].label, help: undefined });
    chips[2].click();
    expect(open).toHaveBeenLastCalledWith({ draft: SUGGESTIONS[2].fill, help: "Say the rule." });
    screen.getByRole("link", { name: /Ask about pay, invoices, drivers/ }).click();
    expect(screen.getByText(TRUST_LINE)).toBeTruthy();
    // Home's ask box never takes the #ask anchor, which the card's own links use.
    expect(document.getElementById("ask")).toBeNull();
  });

  it("makes each chip a plain link to Home's ask without a card on the page", () => {
    render(<AskAnything suggestions={SUGGESTIONS} />);
    const chips = within(screen.getByRole("list", { name: "Questions to ask" })).getAllByRole("link");
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["/#ask", "/#ask", "/#ask"]);
  });
});
