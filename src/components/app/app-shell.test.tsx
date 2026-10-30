// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  flags.agentEnabled = savedAgent;
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

function shell(current: string | null, children = <p>Body</p>, extra: { needsYouCount?: number } = {}) {
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
