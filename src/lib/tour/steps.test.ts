import { describe, expect, it } from "vitest";
import { NEEDS_YOU_ANCHOR, TODAY_ANCHOR } from "@/components/app/anchors";
import { NAV_HREFS } from "@/components/app/app-nav";
import type { Role } from "@/lib/auth/role";
import type { Payday } from "@/lib/home/cards";
import type { NeedsYouView } from "@/lib/home/needs-you";
import type { TourFacts } from "./facts";
import { TOUR_ASKS, TOUR_FOOTER, tourSteps, type TourInput, type TourStep } from "./steps";

// The walkthrough's steps from fixed facts in a fixed zone. Nothing reads the clock or a database:
// every instant is written out, and every figure comes from the input.

const ZONE = "America/Chicago";
// 9:00 AM on Nov 10 in Chicago.
const CHECKED = "2026-11-10T15:00:00.000Z";
const DIGEST = "Good morning. 3 paystubs wait for a look, and $1,500.00 is due out Friday.";

const FACTS: TourFacts = {
  digest: { ok: true, value: DIGEST },
  desk: { ok: true, value: { checkedAt: CHECKED, doneToday: 4 } },
  autopilot: {
    ok: true,
    value: { on: true, paused: false, pausedAt: null, auto: [{ kind: "invoice_post", maxCents: 200_000 }] },
  },
  board: { ok: true, value: 12 },
};

const NEEDS: NeedsYouView = {
  rows: [
    {
      key: "paystubs",
      count: 3,
      atLeast: false,
      what: "paystubs waiting for approval",
      amounts: [{ cents: 150_000, label: "to pay drivers" }],
      href: "/settlements",
      linkLabel: "Open Pay",
    },
    {
      key: "advances",
      count: 2,
      atLeast: false,
      what: "advance requests waiting for a decision",
      amounts: [],
      href: "/advances",
      linkLabel: "Open advances",
    },
  ],
  unread: false,
};

const PAYDAY: Payday = {
  period: { id: "p", start: "2026-11-09", end: "2026-11-15", status: "open" },
  paystubs: 8,
  waiting: 3,
  approved: 4,
  paid: 1,
  held: 0,
  problems: 2,
  netCents: 1_234_567,
};

function input(over: Partial<TourInput> = {}): TourInput {
  return {
    role: "staff",
    timezone: ZONE,
    facts: FACTS,
    needs: NEEDS,
    payday: { ok: true, value: PAYDAY },
    firstQuestion: "Who has a problem on this week's paystub?",
    on: { activityFeed: false, adminAboveCents: 200_000, judgeTurns: 25 },
    ...over,
  };
}

const textOf = (s: TourStep) => [s.title, ...s.lines.map((l) => l.text), s.link?.label ?? ""].join("\n");
const step = (steps: TourStep[], id: TourStep["id"]) => {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} step`);
  return s;
};

describe("tourSteps", () => {
  it("walks the carrier's top items in order, each with its live number", () => {
    const steps = tourSteps(input());
    expect(steps.map((s) => s.id)).toEqual(["working", "waiting", "pay_week", "autopilot", "board", "ask"]);
    const working = step(steps, "working");
    expect(working.title).toBe("Your AI accountant is already working");
    expect(working.lines.map((l) => l.text)).toEqual([
      DIGEST,
      "The desk last checked in Nov 10, 2026, 9:00 AM CST and finished 4 things today.",
    ]);
    expect(step(steps, "waiting").title).toBe("Waiting for a person: 5 items");
    expect(step(steps, "waiting").lines[0].text).toBe("3 paystubs waiting for approval, $1,500.00 to pay drivers");
    expect(step(steps, "pay_week").title).toBe("Paystubs this week: 8 paystubs, $12,345.67");
    expect(step(steps, "pay_week").lines[1].text).toBe("2 paystubs have a problem worth a look before Friday.");
    expect(step(steps, "autopilot").lines[0].text).toBe(
      "On Auto within limits: Sending invoices up to $2,000.00 each. Everything else waits for a person or is off.",
    );
    expect(step(steps, "board").lines[0].text).toBe("12 loads on the board. Move one and watch the desk pick it up.");
    expect(step(steps, "ask").ask).toBe("Who has a problem on this week's paystub?");
    // The footer never names a model.
    expect(TOUR_FOOTER).toBe("Written from today's numbers.");
  });

  it("never tells a demo visitor to approve, and tells them what the visit allows", () => {
    const steps = tourSteps(input({ role: "judge", on: { ...input().on, activityFeed: true } }));
    for (const s of steps) expect(textOf(s), s.id).not.toMatch(/approv/i);
    for (const s of steps) expect(s.ask, s.id).not.toMatch(/approv/i);
    expect(step(steps, "waiting").lines.map((l) => l.text)).toEqual([
      "Open a card and read why the agent proposed it. In this demo you can ask and propose; the carrier's staff make the call.",
    ]);
    expect(step(steps, "ask").lines[1].text).toBe("This visit has 25 questions.");
    for (const s of steps) expect(textOf(s), s.id).not.toMatch(/model time|Muse/i);
    expect(step(steps, "autopilot").lines[1].text).toBe("Read the rules; only the carrier's admin can change them.");
  });

  it("words staff and admin each for what they may do", () => {
    const words = (role: Role) => tourSteps(input({ role }));
    const staff = words("staff");
    expect(step(staff, "waiting").lines.map((l) => l.text)).toContain("Open a card, read why, then approve or reject it.");
    expect(step(staff, "waiting").lines.map((l) => l.text)).toContain("Amounts above $2,000.00 need an admin.");
    expect(step(staff, "autopilot").lines[1].text).toBe("You can pause it in Settings; only an admin changes a rule.");
    expect(textOf(step(staff, "ask"))).not.toContain("This visit");
    const admin = words("admin");
    expect(step(admin, "waiting").lines.map((l) => l.text)).not.toContain("Amounts above $2,000.00 need an admin.");
    expect(step(admin, "autopilot").lines[1].text).toBe("You can change a limit or pause it all in Settings.");
  });

  it("shows the dispatch board and the live feed only with their switches, and the pay week only with its pages", () => {
    const ids = (over: Partial<TourInput>) => tourSteps(input(over)).map((s) => s.id);
    expect(ids({ facts: { ...FACTS, board: null } })).not.toContain("board");
    // A carrier with no board of its own.
    expect(ids({ facts: { ...FACTS, board: { ok: true, value: null } } })).not.toContain("board");
    expect(ids({ facts: { ...FACTS, autopilot: null } })).not.toContain("autopilot");
    expect(ids({ payday: null })).not.toContain("pay_week");
    expect(ids({})).not.toContain("feed");
    const on = tourSteps(input({ on: { ...input().on, activityFeed: true } }));
    expect(on.map((s) => s.id).at(-1)).toBe("feed");
    // The first step links to the feed while it is on, else to the Today card.
    expect(step(on, "working").link).toEqual({ href: "/activity", label: "Open the live feed" });
    expect(step(tourSteps(input()), "working").link?.href).toBe(`#${TODAY_ANCHOR}`);
  });

  it("says a figure could not be read, never 0, and keeps every other step", () => {
    const steps = tourSteps(
      input({
        facts: { digest: { ok: false }, desk: { ok: false }, autopilot: { ok: false }, board: { ok: false } },
        needs: { rows: [], unread: true },
        payday: { ok: false },
      }),
    );
    expect(steps.map((s) => s.id)).toEqual(["working", "waiting", "pay_week", "autopilot", "board", "ask"]);
    const unread = steps.flatMap((s) => s.lines.filter((l) => l.unread).map((l) => l.text));
    expect(unread).toEqual([
      "Could not read the agent's latest morning line.",
      "Could not read when the desk last checked in.",
      "Could not read everything that is waiting right now.",
      "Could not read this week's paystubs.",
      "Could not read the autopilot rules.",
      "Could not read the dispatch board.",
    ]);
    for (const s of steps) expect(textOf(s), s.id).not.toMatch(/\b0\b/);
    expect(step(steps, "waiting").title).toBe("Waiting for a person");
  });

  it("shows the desk's line alone when there is no digest line, and says when nothing is waiting", () => {
    const steps = tourSteps(
      input({ facts: { ...FACTS, digest: { ok: true, value: null }, desk: { ok: true, value: { checkedAt: null, doneToday: 0 } } }, needs: { rows: [], unread: false } }),
    );
    expect(step(steps, "working").lines.map((l) => l.text)).toEqual(["The desk has not checked in yet."]);
    expect(step(steps, "waiting").title).toBe("Waiting for a person: nothing right now");
  });

  it("words the autopilot off, paused and with nothing on Auto", () => {
    const line = (value: NonNullable<TourFacts["autopilot"]>) =>
      step(tourSteps(input({ facts: { ...FACTS, autopilot: value } })), "autopilot").lines[0].text;
    expect(line({ ok: true, value: { on: false, paused: false, pausedAt: null, auto: [] } })).toBe(
      "The autopilot is off. A person decides everything.",
    );
    expect(line({ ok: true, value: { on: true, paused: true, pausedAt: CHECKED, auto: [] } })).toBe(
      "Paused since Nov 10, 2026, 9:00 AM CST. A person decides everything until it resumes.",
    );
    expect(line({ ok: true, value: { on: true, paused: false, pausedAt: null, auto: [] } })).toBe(
      "Nothing is on Auto. A person decides everything.",
    );
  });

  it("gives every step a fixed question, and every link a menu page, a known page or an anchor on Home", () => {
    const known = new Set([...NAV_HREFS, "/settings/autopilot", "/tms-demo", `#${NEEDS_YOU_ANCHOR}`, `#${TODAY_ANCHOR}`]);
    for (const role of ["admin", "staff", "judge"] as const) {
      for (const s of tourSteps(input({ role, on: { ...input().on, activityFeed: true } }))) {
        expect(s.ask.length, s.id).toBeGreaterThan(0);
        if (s.id !== "ask") expect(s.ask).toBe(TOUR_ASKS[s.id]);
        if (s.id === "ask") expect(s.link).toBeUndefined();
        else expect(known.has(s.link?.href ?? ""), `${s.id} ${s.link?.href}`).toBe(true);
      }
    }
    expect(NAV_HREFS).toContain("/settlements");
    expect(NAV_HREFS).toContain("/activity");
  });
});

describe("tourSteps under the simple Home", () => {
  const simple = (over: Partial<TourInput> = {}) =>
    tourSteps(input({ today: "2026-11-10", ...over, on: { ...input().on, simpleShape: true, ...over.on } }));

  it("has one step per block on Home, and the first says when the books were last checked", () => {
    const steps = simple();
    expect(steps.map((s) => s.id)).toEqual(["working", "waiting", "ask"]);
    // No digest line: the desk's line alone, the time of day alone for a check-in today.
    expect(step(steps, "working").lines.map((l) => l.text)).toEqual(["Last checked the books at 9:00 AM and finished 4 things today."]);
    expect(step(simple({ today: "2026-11-11" }), "working").lines[0].text).toBe(
      "Last checked the books on Nov 10, 2026, 9:00 AM CST and finished 4 things today.",
    );
    // The pay week, autopilot, board and feed steps describe pages no longer on Home.
    expect(simple({ on: { ...input().on, activityFeed: true } }).map((s) => s.id)).toEqual(["working", "waiting", "ask"]);
  });

  it("says the books were not checked, or could not be read, never 0", () => {
    const none = simple({ facts: { ...FACTS, desk: { ok: true, value: { checkedAt: null, doneToday: 0 } } } });
    expect(step(none, "working").lines).toEqual([{ text: "Not checked yet today." }]);
    const failed = simple({ facts: { ...FACTS, desk: { ok: false } } });
    expect(step(failed, "working").lines).toEqual([{ text: "Could not read when I last checked the books.", unread: true }]);
  });

  it("never names a model or its cost, for any role", () => {
    for (const role of ["admin", "staff", "judge"] as const) {
      for (const s of simple({ role })) expect(textOf(s), `${role} ${s.id}`).not.toMatch(/model time|cents|Muse|digest/i);
    }
  });
});
