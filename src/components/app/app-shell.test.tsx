// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { PageFocus } from "@/components/agent/page-focus";
import { flags } from "@/config/flags";
import { AppShell, type NavItem } from "./app-shell";
import { AMOUNTS_KEY } from "./hide-amounts";
import { MASKED_AMOUNT, Money } from "./money";
import { TEST_MODE_LINE, testModeOnly } from "./test-mode-banner";

// A storage of the test's own, so the eye's saved choice is read back here and never left behind.
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const savedAgent = flags.agentEnabled;
const savedFocus = flags.agentFocusEnabled;
const savedSimple = flags.simpleShape.enabled;
// Written for the full shell; the simple shape's tests turn its switch on.
beforeEach(() => {
  flags.simpleShape.enabled = false;
});
afterEach(() => {
  flags.agentEnabled = savedAgent;
  flags.agentFocusEnabled = savedFocus;
  flags.simpleShape.enabled = savedSimple;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.amounts;
  cleanup();
});

const TENANT = { name: "Test Carrier", email: "office@example.test", timezone: "America/Chicago", role: "staff" as const };
const NAV: NavItem[] = [
  { group: "Today", area: "primary", href: "/", label: "Home", icon: null },
  { group: "Pay", area: "pay", href: "/settlements", label: "Settlements", icon: null },
  { group: "Pay", area: "pay", href: "/advances", label: "Advances", icon: null },
  { group: "Money in", area: "billing", href: "/invoices", label: "Invoices", icon: null },
  { group: "Settings", area: "books", href: "/models", label: "Models and spend", icon: null },
];

function shell(
  current: string | null,
  children = <p>Body</p>,
  extra: { needsYouCount?: number; agentPanel?: boolean; focus?: PageFocus } = {},
) {
  return render(
    <AppShell
      tenant={TENANT}
      nav={NAV.map((i) => ({ ...i, current: i.href === current }))}
      title="Page"
      signOut={<button type="button">Sign out</button>}
      {...extra}
    >
      {children}
    </AppShell>,
  );
}

describe("the test-mode banner", () => {
  it("runs across every page while payouts and postings are test-only", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    shell("/advances");
    const banner = screen.getByRole("region", { name: "Test mode" });
    expect(banner.textContent).toBe(TEST_MODE_LINE);
    expect(screen.getByRole("link", { name: "Test mode" }).getAttribute("href")).toBe("/settings/accounting");
  });

  it("is left off when the books point anywhere but the sandbox", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    shell("/advances");
    expect(screen.queryByRole("region", { name: "Test mode" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Test mode" })).toBeNull();
  });

  it("says test mode only for the mock or test payout provider and the sandbox books", () => {
    expect(testModeOnly({ paymentProvider: "mock" }, {})).toBe(true);
    expect(testModeOnly({ paymentProvider: "stripe_test" }, { QBO_ENVIRONMENT: "" })).toBe(true);
    expect(testModeOnly({ paymentProvider: "stripe_test" }, { QBO_ENVIRONMENT: "sandbox" })).toBe(true);
    expect(testModeOnly({ paymentProvider: "stripe_test" }, { QBO_ENVIRONMENT: "production" })).toBe(false);
    expect(testModeOnly({ paymentProvider: "live" as never }, { QBO_ENVIRONMENT: "sandbox" })).toBe(false);
  });
});

describe("the top bar", () => {
  it("offers the agent's box and the Ask row while the agent is on", () => {
    flags.agentEnabled = true;
    shell("/advances");
    const box = screen.getByRole("link", { name: "Search or ask anything" });
    expect(box.getAttribute("href")).toBe("/#ask");
    expect(screen.getAllByRole("link", { name: "Ask" }).length).toBeGreaterThan(0);
  });

  it("leaves the agent's box and the Ask row out while the agent is off", () => {
    flags.agentEnabled = false;
    shell("/advances");
    expect(screen.queryByRole("link", { name: "Search or ask anything" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ask" })).toBeNull();
  });

  it("prints no group line, and the bell counts what waits only when the page passed a count", () => {
    const { container, unmount } = shell("/advances");
    const header = () => container.ownerDocument.querySelector("header") as HTMLElement;
    expect(header().querySelector(":scope > p")).toBeNull();
    expect(within(header()).getByRole("link", { name: "Needs you" }).getAttribute("href")).toBe("/#needs-you");
    unmount();
    shell("/", <p>Body</p>, { needsYouCount: 3 });
    expect(within(header()).getByRole("link", { name: "Needs you, 3 waiting" })).toBeTruthy();
  });
});

describe("the sidebar", () => {
  it("keeps exactly one carrier menu, with Sign out inside it", () => {
    const { container } = shell("/advances");
    const menus = [...container.querySelectorAll("summary")].filter((s) => s.textContent?.includes("carrier menu"));
    expect(menus).toHaveLength(1);
    const details = menus[0].closest("details") as HTMLDetailsElement;
    expect(within(details).getByRole("button", { name: "Sign out", hidden: true })).toBeTruthy();
  });

  it("opens the current page's area and links each tab to its first page", () => {
    const { container } = shell("/advances");
    const tabs = container.querySelector('aside ul[aria-label="Areas"]') as HTMLElement;
    const links = within(tabs).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href"), l.getAttribute("aria-current")])).toEqual([
      ["Pay", "/settlements", "true"],
      ["Billing", "/invoices", null],
      ["Books", "/models", null],
    ]);
    const aside = container.querySelector("aside") as HTMLElement;
    expect(within(aside).getByRole("link", { name: "Advances" }).getAttribute("aria-current")).toBe("page");
    expect(within(aside).queryByRole("link", { name: "Invoices" })).toBeNull();
  });

  it("opens Pay on a page with no menu item of its own, and Books from a Books page", () => {
    const { container, unmount } = shell(null);
    const current = () =>
      container.querySelector('aside ul[aria-label="Areas"] [aria-current="true"]')?.textContent;
    expect(current()).toBe("Pay");
    expect(screen.getByText("Body")).toBeTruthy();
    unmount();
    const again = shell("/models");
    expect(again.container.querySelector('aside ul[aria-label="Areas"] [aria-current="true"]')?.textContent).toBe(
      "Books",
    );
  });

  it("shows a nav with no areas (the design page) as one flat list with no tabs", () => {
    const { container } = render(
      <AppShell tenant={TENANT} nav={[{ href: "#a", label: "First", icon: null }]} title="Page" signOut={null}>
        <p>Body</p>
      </AppShell>,
    );
    expect(container.querySelector('ul[aria-label="Areas"]')).toBeNull();
    expect(within(container.querySelector("aside") as HTMLElement).getByRole("link", { name: "First" })).toBeTruthy();
  });
});

// The simple shape (flags.simpleShape): the five-word menu and one notice across the top.
const SIMPLE_NAV: NavItem[] = [
  { group: "Today", area: "primary", section: "home", sectionOrder: 0, href: "/", label: "Home", icon: null },
  { group: "Today", area: "pay", section: "home", sectionOrder: 10, href: "/activity", label: "Live feed", icon: null },
  { group: "Pay", area: "pay", section: "pay", sectionOrder: 10, sectionLabel: "Paystubs", href: "/settlements", label: "Settlements", icon: null },
  { group: "Pay", area: "pay", section: "pay", sectionOrder: 20, sectionLabel: "Pay check", href: "/sweep", label: "Pay sweep", icon: null },
  { group: "Pay", area: "pay", section: "pay", sectionOrder: 30, href: "/advances", label: "Advances", icon: null },
  { group: "Money in", area: "billing", section: "billing", sectionOrder: 10, href: "/invoices", label: "Invoices", icon: null },
  { group: "Drivers", area: "pay", section: "drivers", sectionOrder: 10, href: "/drivers", label: "Drivers", icon: null },
  { group: "Settings", area: "books", section: "settings", sectionOrder: 0, href: "/settings", label: "Settings", icon: null },
  { group: "Settings", area: "books", section: "settings", sectionOrder: 80, href: "/models", label: "Models and spend", icon: null },
];

function simpleShell(current: string | null, role: "admin" | "staff" | "judge" = "staff", nav = SIMPLE_NAV) {
  flags.simpleShape.enabled = true;
  return render(
    <AppShell
      tenant={{ ...TENANT, name: "Blue Ridge Freight Lines", role }}
      nav={nav.map((i) => ({ ...i, current: i.href === current }))}
      title="Page"
      signOut={<button type="button">Sign out</button>}
      pinned={{ payWeekCents: 100_00, dueCents: 200_00 }}
    >
      <p>Body</p>
    </AppShell>,
  );
}

describe("the sidebar under the simple shape", () => {
  const aside = (c: HTMLElement) => c.querySelector("aside") as HTMLElement;
  const rows = (c: HTMLElement) =>
    [...aside(c).querySelectorAll('ul[aria-label="Sections"] > li > a')].map((a) => [
      a.textContent,
      a.getAttribute("href"),
      a.getAttribute("aria-current"),
    ]);

  it("shows the five words, each to its own page or its first page", () => {
    const { container } = simpleShell("/");
    expect(rows(container)).toEqual([
      ["Home", "/", "page"],
      ["Pay", "/settlements", null],
      ["Billing", "/invoices", null],
      ["Drivers", "/drivers", null],
      ["Settings", "/settings", null],
    ]);
    // Home lists nothing under it; the live feed is reached from Home's own link.
    expect(within(aside(container)).queryByRole("link", { name: "Live feed" })).toBeNull();
    expect(within(aside(container)).queryByRole("list", { name: "Pay" })).toBeNull();
  });

  it("opens the current page's section with its pages under it, the exact page marked, the others closed", () => {
    const { container } = simpleShell("/advances");
    const pay = within(aside(container)).getByRole("list", { name: "Pay" });
    expect(within(pay).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("aria-current")])).toEqual([
      ["Paystubs", null],
      ["Pay check", null],
      ["Advances", "page"],
    ]);
    expect(within(aside(container)).queryByRole("link", { name: "Invoices" })).toBeNull();
    expect(rows(container).find((r) => r[0] === "Pay")?.[2]).toBeNull();
  });

  it("marks the Settings row itself on the Settings page, and lists its pages under it", () => {
    const { container } = simpleShell("/settings");
    expect(rows(container).find((r) => r[0] === "Settings")?.[2]).toBe("page");
    const settings = within(aside(container)).getByRole("list", { name: "Settings" });
    expect(within(settings).getAllByRole("link").map((l) => l.textContent)).toEqual(["Models and spend"]);
  });

  it("opens no section on a page with no menu item, and leaves out a section with no page shown", () => {
    const { container } = simpleShell(
      null,
      "staff",
      SIMPLE_NAV.filter((i) => i.section !== "billing"),
    );
    expect(rows(container).map((r) => r[0])).toEqual(["Home", "Pay", "Drivers", "Settings"]);
    expect(aside(container).querySelectorAll('ul[aria-label="Sections"] ul')).toHaveLength(0);
  });

  it("leaves out the area tabs, Pinned, and the Needs you and Ask rows, and keeps the bell", () => {
    flags.agentEnabled = true;
    const { container } = simpleShell("/advances");
    expect(container.querySelector('ul[aria-label="Areas"]')).toBeNull();
    expect(container.querySelector('ul[aria-label="Pinned"]')).toBeNull();
    expect(within(aside(container)).queryByRole("link", { name: "Needs you" })).toBeNull();
    expect(within(aside(container)).queryByRole("link", { name: "Ask" })).toBeNull();
    const header = container.ownerDocument.querySelector("header") as HTMLElement;
    expect(within(header).getByRole("link", { name: "Needs you" }).getAttribute("href")).toBe("/#needs-you");
  });

  it("puts the same five words in the phone sheet", () => {
    // jsdom has no dialog methods: opening sets the attribute.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    onTestFinished(() => void Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"));
    simpleShell("/advances");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheets = screen.getAllByRole("list", { name: "Sections", hidden: true });
    expect(sheets).toHaveLength(2);
    expect(within(sheets[1]).getAllByRole("link", { hidden: true }).map((l) => l.textContent)).toEqual([
      "Home",
      "Pay",
      "Paystubs",
      "Pay check",
      "Advances",
      "Billing",
      "Drivers",
      "Settings",
    ]);
  });
});

describe("one notice across the top under the simple shape", () => {
  const regions = () =>
    screen.queryAllByRole("region").filter((r) => ["Test mode", "Demo visit"].includes(r.getAttribute("aria-label") ?? ""));

  it("gives staff the test-mode line alone, with no chip in the top bar", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    simpleShell("/advances");
    expect(regions().map((r) => [r.getAttribute("aria-label"), r.textContent])).toEqual([["Test mode", TEST_MODE_LINE]]);
    expect(screen.queryByRole("link", { name: "Test mode" })).toBeNull();
  });

  it("gives a demo visitor one line in place of the test-mode line and the demo line", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    simpleShell("/advances", "judge");
    const only = regions();
    expect(only).toHaveLength(1);
    expect(only[0].getAttribute("aria-label")).toBe("Demo visit");
    expect(only[0].querySelector("p")?.textContent).toBe("Demo of Blue Ridge Freight Lines, made-up data. Nothing real moves.");
    expect(within(only[0]).getByRole("button", { name: "Start over" })).toBeTruthy();
    expect(within(only[0]).getByRole("button", { name: "Leave" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Test mode" })).toBeNull();
  });

  it("never says nothing real moves when the books point anywhere but the sandbox", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    simpleShell("/advances", "judge");
    expect(regions().map((r) => r.querySelector("p")?.textContent)).toEqual(["Demo of Blue Ridge Freight Lines, made-up data."]);
    cleanup();
    simpleShell("/advances", "staff");
    expect(regions()).toEqual([]);
  });

  it("keeps both lines and the chip with the switch off", () => {
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    flags.simpleShape.enabled = false;
    render(
      <AppShell tenant={{ ...TENANT, role: "judge" }} nav={NAV} title="Page" signOut={null}>
        <p>Body</p>
      </AppShell>,
    );
    expect(regions().map((r) => r.getAttribute("aria-label"))).toEqual(["Test mode", "Demo visit"]);
    expect(screen.getByRole("link", { name: "Test mode" })).toBeTruthy();
  });
});

describe("hide amounts", () => {
  const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");

  it("is one selector in the stylesheet and in the code", () => {
    expect(css).toContain(`${MASKED_AMOUNT} {`);
    expect(css).toContain(`${MASKED_AMOUNT}::after {`);
  });

  it("hides page amounts and never one inside data-amounts=\"shown\"", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    shell(
      "/advances",
      <>
        <p data-testid="page">
          <Money cents={12_345} />
        </p>
        <div data-amounts="shown" data-testid="approve">
          <Money cents={20_000} />
        </div>
      </>,
    );
    const pageAmount = screen.getByTestId("page").querySelector("[data-money]") as HTMLElement;
    const approveAmount = screen.getByTestId("approve").querySelector("[data-money]") as HTMLElement;
    const eye = screen.getByRole("button", { name: "Hide amounts" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    expect(pageAmount.matches(MASKED_AMOUNT)).toBe(false);

    fireEvent.click(eye);
    expect(document.documentElement.dataset.amounts).toBe("hidden");
    await waitFor(() => expect(eye.getAttribute("aria-pressed")).toBe("true"));
    expect(storage.getItem(AMOUNTS_KEY)).toBe("hidden");
    expect(pageAmount.matches(MASKED_AMOUNT)).toBe(true);
    // The amount a person approves keeps its own attribute and stays in plain view, text and all.
    expect(screen.getByTestId("approve").dataset.amounts).toBe("shown");
    expect(approveAmount.matches(MASKED_AMOUNT)).toBe(false);
    expect(approveAmount.textContent).toBe("$200.00");
    // The page's text is unchanged either way; only the stylesheet draws it blurred.
    expect(pageAmount.textContent).toBe("$123.45");
    expect(pageAmount.dataset.money).toBe("$123.45");

    fireEvent.click(eye);
    expect(document.documentElement.dataset.amounts).toBeUndefined();
    await waitFor(() => expect(eye.getAttribute("aria-pressed")).toBe("false"));
    expect(storage.getItem(AMOUNTS_KEY)).toBeNull();
    expect(pageAmount.matches(MASKED_AMOUNT)).toBe(false);
  });
});

describe("the agent launcher", () => {
  // jsdom has no dialog methods: opening sets the attribute, closing clears it and fires close.
  beforeEach(() => {
    HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ conversationId: null, turns: [] }), { status: 200 })),
    );
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  const launcher = () => screen.queryByRole("button", { name: "Ask the agent" });

  it("shows on every page, Home included, while the agent is on, and reads no thread until it opens", () => {
    flags.agentEnabled = true;
    flags.agentFocusEnabled = true;
    const off = shell("/advances");
    expect(launcher()).not.toBeNull();
    off.unmount();
    shell("/");
    expect(launcher()).not.toBeNull();
    expect(screen.getByRole("link", { name: "Search or ask anything" }).getAttribute("aria-haspopup")).toBe("dialog");
    // With the agent's questions on, the launcher's only read is their poll; the thread waits for a click.
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u !== "/api/agent/asks")).toEqual([]);
  });

  it("is left off with the agent off or a page that asks for none, and makes no request then", () => {
    flags.agentEnabled = false;
    flags.agentFocusEnabled = true;
    const off = shell("/advances");
    expect(launcher()).toBeNull();
    off.unmount();
    flags.agentEnabled = true;
    shell("/design", <p>Body</p>, { agentPanel: false });
    expect(launcher()).toBeNull();
    // Without a card on the page, Ask is a plain link to Home's #ask, which opens the card there.
    const box = screen.getByRole("link", { name: "Search or ask anything" });
    expect(box.getAttribute("href")).toBe("/#ask");
    expect(box.getAttribute("aria-haspopup")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still shows with page focus off, with no chip for the page's record", async () => {
    flags.agentEnabled = true;
    flags.agentFocusEnabled = false;
    shell("/advances", <p>Body</p>, {
      focus: { table: "drivers", id: "11111111-1111-4111-8111-111111111111", label: "Dana Reyes" },
    });
    const button = launcher();
    if (!button) throw new Error("no launcher");
    fireEvent.click(button);
    const panel = await screen.findByRole("dialog", { name: "Agent" });
    await within(panel).findByRole("textbox", { name: "Your question" });
    expect(within(panel).queryByText("About: Dana Reyes")).toBeNull();
  });

  it("opens from Ask on Home with the cursor in the card's box, never in a blocked card's reason box", async () => {
    flags.agentEnabled = true;
    shell("/", <textarea aria-label="Why approve it anyway?" />);
    fireEvent.click(screen.getByRole("link", { name: "Search or ask anything" }));
    const panel = await screen.findByRole("dialog", { name: "Agent" });
    const box = await within(panel).findByRole("textbox", { name: "Your question" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    // The card's greeting names the carrier.
    expect(within(panel).getByRole("heading", { name: "Hey, Test Carrier. How can I be helpful?" })).toBeTruthy();
  });

  it("opens from the top bar's Ask off Home, with the cursor in the panel's question box", async () => {
    flags.agentEnabled = true;
    flags.agentFocusEnabled = true;
    shell("/advances", <p>Body</p>, {
      focus: { table: "drivers", id: "11111111-1111-4111-8111-111111111111", label: "Dana Reyes" },
    });
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Search or ask anything" }));
    const panel = await screen.findByRole("dialog", { name: "Agent" });
    const box = await within(panel).findByRole("textbox", { name: "Your question" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(within(panel).getByText("About: Dana Reyes")).toBeTruthy();
    expect(screen.getAllByRole("textbox", { name: "Your question" })).toHaveLength(1);
  });
});

